import { performance } from "node:perf_hooks";
import { projectGvqlRows } from "./gvql-aggregation.js";
import { evaluateGvqlValueExpression } from "./gvql-expressions.js";
import { buildGvqlGraphIndex, propertyIndexKey } from "./gvql-index.js";
import { applyGvqlMutations } from "./gvql-mutations.js";
import { encodedValueToJs, getNodePath, literalToJs, nodeSummary } from "./gvql-values.js";
import type { EncodedNode, SerializedEnvelope } from "../core/types.js";
import type {
  GvqlBinding,
  GvqlBooleanExpression,
  GvqlExecutionOptions,
  GvqlExecutionPlan,
  GvqlGraphEdge,
  GvqlGraphIndex,
  GvqlHavingClause,
  GvqlLiteral,
  GvqlMatchPattern,
  GvqlPathExpression,
  GvqlValueExpression,
  GvqlPredicate,
  GvqlResult,
  GvqlRowPredicate,
  GvqlStatement,
} from "./gvql-types.js";

interface IndexedCandidateSelection {
  path: string;
  source: Extract<GvqlExecutionPlan["candidateSource"], "property-index" | "type-index" | "id-index">;
  objectIds: string[];
  propertyIndexes: NonNullable<GvqlExecutionPlan["propertyIndexes"]>;
  operation: string;
}

interface IndexablePredicate {
  path: string;
  keyValues: Array<{ key: string; value: unknown }>;
}

interface IndexablePredicateSet {
  mode: "AND" | "OR";
  predicates: IndexablePredicate[];
}

export function executeGvqlStatement(envelope: SerializedEnvelope, statement: GvqlStatement, options: GvqlExecutionOptions = {}): GvqlResult {
  const started = performance.now();
  const parameters = options.parameters ?? {};
  const index = buildGvqlGraphIndex(envelope);
  const matched = matchBindingsWithPlan(index, statement, parameters);
  const bindings = matched.bindings.filter((binding) => matchesWhere(index, binding, statement, parameters));
  if (statement.kind === "select") {
    const rows = projectSelectRows(index, bindings, statement, parameters);
    const plan = completePlan(matched.plan, bindings, rows.length, statement);
    return {
      kind: "select",
      statement,
      rows,
      matched: bindings.length,
      scannedObjects: index.nodes.size,
      elapsedMs: performance.now() - started,
      plan,
    };
  }
  if (!options.allowMutations && !options.dryRun) {
    throw new Error("GVQL update statements require allowMutations.");
  }
  const limitedBindings = applyBindingOrderingAndLimit(index, bindings, statement);
  const deleteRows = statement.delete.length > 0 ? projectGvqlRows(index, limitedBindings, statement, readPath, readNode, parameters) : undefined;
  const changes = applyGvqlMutations(index, limitedBindings, statement, options, readPath);
  const rows = deleteRows ?? projectGvqlRows(index, limitedBindings, statement, readPath, readNode, parameters);
  const plan = completePlan(matched.plan, bindings, rows.length, statement);
  return {
    kind: "update",
    statement,
    rows,
    matched: bindings.length,
    changed: changes.length,
    scannedObjects: index.nodes.size,
    elapsedMs: performance.now() - started,
    dryRun: options.dryRun ?? false,
    changes,
    plan,
  };
}

function projectSelectRows(
  index: GvqlGraphIndex,
  bindings: GvqlBinding[],
  statement: GvqlStatement,
  parameters: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (statement.with) {
    const withStatement = { ...statement, returns: statement.with.returns, distinct: statement.with.distinct };
    const projected = projectGvqlRows(index, bindings, withStatement, readPath, readNode, parameters).filter((row) => matchesHaving(row, withStatement, parameters));
    const withRows = statement.with.distinct ? distinctRows(projected) : projected;
    const filtered = statement.with.where ? withRows.filter((row) => matchesRowBoolean(row, statement.with?.where, parameters)) : withRows;
    const finalRows = projectRowsFromRows(filtered, statement.returns);
    const rows = statement.distinct ? distinctRows(finalRows) : finalRows;
    return applyRowOrderingAndLimit(rows, statement);
  }
  if (isAggregateStatement(statement) || statement.having || hasAliasOrdering(statement)) {
    const projected = projectGvqlRows(index, bindings, statement, readPath, readNode, parameters).filter((row) => matchesHaving(row, statement, parameters));
    const rows = statement.distinct ? distinctRows(projected) : projected;
    return applyRowOrderingAndLimit(rows, statement);
  }
  const orderedBindings = applyBindingOrdering(index, bindings, statement);
  if (statement.distinct) {
    const rows = distinctRows(projectGvqlRows(index, orderedBindings, statement, readPath, readNode, parameters));
    return applyOffsetAndLimit(rows, statement);
  }
  return projectGvqlRows(index, applyOffsetAndLimit(orderedBindings, statement), statement, readPath, readNode, parameters);
}

function projectRowsFromRows(rows: Array<Record<string, unknown>>, returns: GvqlStatement["returns"]): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const projected: Record<string, unknown> = {};
    for (const item of returns) {
      if (item.kind === "all" && !item.alias) {
        Object.assign(projected, row);
      } else if (item.kind === "row") {
        projected[item.aliasName ?? item.source] = row[item.source];
      } else {
        throw new Error("GVQL RETURN after WITH currently supports row aliases and RETURN *.");
      }
    }
    return projected;
  });
}

export function matchBindings(index: GvqlGraphIndex, statement: GvqlStatement, parameters: Record<string, unknown> = {}): GvqlBinding[] {
  return matchBindingsWithPlan(index, statement, parameters).bindings;
}

function matchBindingsWithPlan(
  index: GvqlGraphIndex,
  statement: GvqlStatement,
  parameters: Record<string, unknown> = {},
): { bindings: GvqlBinding[]; plan: GvqlExecutionPlan } {
  const patterns = statement.matches.length ? statement.matches : [statement.match];
  const optionalPatterns = statement.optionalMatches ?? [];
  let bindings: GvqlBinding[] = [{}];
  let firstSelection: ReturnType<typeof candidates> | undefined;
  const operations: string[] = patterns.length > 1 ? [`multi-match:${patterns.length}`] : [];
  let edgeSteps = 0;
  for (const pattern of patterns) {
    const selection = candidates(index, statement, pattern, parameters);
    firstSelection ??= selection;
    bindings = matchPattern(index, pattern, bindings, selection, operations);
    edgeSteps += pattern.chain.length;
  }
  for (const pattern of optionalPatterns) {
    const selection = candidates(index, statement, pattern, parameters);
    bindings = matchPattern(index, pattern, bindings, selection, operations, { optional: true });
    edgeSteps += pattern.chain.length;
  }
  const selection = firstSelection ?? {
    objectIds: [],
    source: "full-scan" as const,
    operations: ["full-scan"],
  };
  return {
    bindings,
    plan: {
      nodeCount: index.nodes.size,
      candidateSource: selection.source,
      indexUsed: selection.source !== "full-scan",
      ...(patterns[0]?.start.type ? { startType: patterns[0].start.type } : {}),
      ...(selection.propertyIndex ? { propertyIndex: selection.propertyIndex } : {}),
      ...(selection.propertyIndexes ? { propertyIndexes: selection.propertyIndexes } : {}),
      startCandidates: selection.objectIds.length,
      edgeSteps,
      matchedBindings: bindings.length,
      filteredBindings: bindings.length,
      returnedRows: 0,
      ...(typeof statement.limit === "number" ? { limit: statement.limit } : {}),
      offset: statement.offset ?? 0,
      distinct: statement.distinct,
      grouped: isAggregateStatement(statement),
      having: Boolean(statement.having),
      operations,
    },
  };
}

function matchPattern(
  index: GvqlGraphIndex,
  pattern: GvqlMatchPattern,
  inputBindings: GvqlBinding[],
  selection: ReturnType<typeof candidates>,
  operations: string[],
  options: { optional?: boolean } = {},
): GvqlBinding[] {
  const startCandidates = new Set(selection.objectIds);
  operations.push(...selection.operations);
  if (options.optional) operations.push(`optional-match:${pattern.start.alias}`);
  const matchedBindings: GvqlBinding[] = [];
  let unmatched = 0;
  recordPatternTraversals(pattern, operations);
  for (const binding of inputBindings) {
    const boundStart = binding[pattern.start.alias];
    const objectIds = boundStart ? [boundStart] : selection.objectIds;
    let bindings: GvqlBinding[] = [];
    for (const objectId of objectIds) {
      if (!startCandidates.has(objectId) || !matchesType(index, objectId, pattern.start.type)) continue;
      bindings.push({ ...binding, [pattern.start.alias]: objectId });
    }
    bindings = traversePatternChain(index, pattern, bindings);
    if (bindings.length > 0) {
      matchedBindings.push(...bindings);
    } else if (options.optional) {
      matchedBindings.push(binding);
      unmatched++;
    }
  }
  if (unmatched > 0) operations.push(`optional-unmatched:${unmatched}`);
  return matchedBindings;
}

function traversePatternChain(
  index: GvqlGraphIndex,
  pattern: GvqlMatchPattern,
  inputBindings: GvqlBinding[],
): GvqlBinding[] {
  let bindings = inputBindings;
  for (const link of pattern.chain) {
    const nextBindings: GvqlBinding[] = [];
    for (const binding of bindings) {
      const fromId = binding[previousAlias(pattern, link)];
      if (!fromId) continue;
      const edges = link.edge.direction === "out" ? index.outgoing.get(fromId) ?? [] : index.incoming.get(fromId) ?? [];
      for (const edge of edges) {
        if (link.edge.label && edge.label !== link.edge.label && edge.path !== link.edge.label) continue;
        const targetId = link.edge.direction === "out" ? edge.to : edge.from;
        if (!matchesType(index, targetId, link.node.type)) continue;
        const existing = binding[link.node.alias];
        if (existing && existing !== targetId) continue;
        nextBindings.push({ ...binding, [link.node.alias]: targetId });
      }
    }
    bindings = nextBindings;
  }
  return bindings;
}

function recordPatternTraversals(pattern: GvqlMatchPattern, operations: string[]): void {
  for (const link of pattern.chain) {
    operations.push(`${link.edge.direction === "out" ? "traverse" : "reverse-traverse"}:${link.edge.label ?? "*"}`);
  }
}

function previousAlias(pattern: GvqlMatchPattern, target: GvqlMatchPattern["chain"][number]): string {
  let previous = pattern.start.alias;
  for (const item of pattern.chain) {
    if (item === target) return previous;
    previous = item.node.alias;
  }
  return previous;
}

function candidates(
  index: GvqlGraphIndex,
  statement: GvqlStatement,
  pattern: GvqlMatchPattern,
  parameters: Record<string, unknown>,
): {
  objectIds: string[];
  source: GvqlExecutionPlan["candidateSource"];
  propertyIndex?: GvqlExecutionPlan["propertyIndex"];
  propertyIndexes?: GvqlExecutionPlan["propertyIndexes"];
  operations: string[];
} {
  const type = pattern.start.type;
  const typeCandidates = type ? index.byType.get(type) ?? [] : Array.from(index.nodes.keys());
  const indexed = indexablePredicates(statement, pattern, parameters);
  if (!indexed || indexed.predicates.length === 0) {
    return {
      objectIds: typeCandidates,
      source: type ? "type-index" : "full-scan",
      operations: [type ? `type-index:${type}` : "full-scan"],
    };
  }
  const indexedCandidates = indexed
    .predicates
    .map((item) => indexedCandidateSelection(index, item))
    .sort((a, b) => a.objectIds.length - b.objectIds.length);
  const allowed =
    indexed.mode === "OR"
      ? new Set(unionCandidates(indexedCandidates.map((item) => item.objectIds)))
      : intersectCandidates(indexedCandidates.map((item) => item.objectIds));
  const propertyIndexes = indexedCandidates.flatMap((item) => item.propertyIndexes);
  const source = indexedCandidates.find((item) => item.source === "property-index")?.source ?? indexedCandidates[0]?.source ?? (type ? "type-index" : "full-scan");
  return {
    objectIds: typeCandidates.filter((objectId) => allowed.has(objectId)),
    source,
    ...(propertyIndexes[0] ? { propertyIndex: { path: propertyIndexes[0].path, key: propertyIndexes[0].key, value: propertyIndexes[0].value } } : {}),
    propertyIndexes,
    operations: [
      ...indexedCandidates.map((item) => item.operation),
      ...(indexedCandidates.length > 1
        ? [indexed.mode === "OR" ? `index-or-union:${indexedCandidates.length}` : `property-index-intersect:${indexedCandidates.length}`]
        : []),
      ...(type ? [`type-filter:${type}`] : []),
    ],
  };
}

function indexedCandidateSelection(
  index: GvqlGraphIndex,
  item: { path: string; keyValues: Array<{ key: string; value: unknown }> },
): IndexedCandidateSelection {
  if (item.path === "$id") {
    return metadataCandidateSelection(index, item, "id-index");
  }
  if (item.path === "$type") {
    return metadataCandidateSelection(index, item, "type-index");
  }
  const keyedCandidates = item.keyValues.map(({ key, value }) => ({ key, value, objectIds: index.byProperty.get(key) ?? [] }));
  if (keyedCandidates.length === 1) {
    const only = keyedCandidates[0] as { key: string; value: unknown; objectIds: string[] };
    return {
      path: item.path,
      source: "property-index",
      objectIds: only.objectIds,
      propertyIndexes: [{ path: item.path, key: only.key, value: only.value, candidates: only.objectIds.length }],
      operation: `property-index:${item.path}`,
    };
  }
  const seen = new Set<string>();
  const union: string[] = [];
  for (const candidate of keyedCandidates) {
    for (const objectId of candidate.objectIds) {
      if (seen.has(objectId)) continue;
      seen.add(objectId);
      union.push(objectId);
    }
  }
  return {
    path: item.path,
    source: "property-index",
    objectIds: union,
    propertyIndexes: keyedCandidates.map((candidate) => ({
      path: item.path,
      key: candidate.key,
      value: candidate.value,
      candidates: candidate.objectIds.length,
    })),
    operation: `property-index-union:${item.path}:${keyedCandidates.length}`,
  };
}

function metadataCandidateSelection(
  index: GvqlGraphIndex,
  item: { path: string; keyValues: Array<{ key: string; value: unknown }> },
  source: Extract<GvqlExecutionPlan["candidateSource"], "type-index" | "id-index">,
): IndexedCandidateSelection {
  const lists = item.keyValues.map(({ value }) => {
    if (source === "id-index") {
      return typeof value === "string" && index.nodes.has(value) ? [value] : [];
    }
    return typeof value === "string" ? index.byType.get(value) ?? [] : [];
  });
  const objectIds = unionCandidates(lists);
  return {
    path: item.path,
    source,
    objectIds,
    propertyIndexes: [],
    operation: item.keyValues.length > 1 ? `${source}-union:${item.path}:${item.keyValues.length}` : `${source}:${String(item.keyValues[0]?.value ?? "unknown")}`,
  };
}

function unionCandidates(candidateLists: string[][]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidates of candidateLists) {
    for (const objectId of candidates) {
      if (seen.has(objectId)) continue;
      seen.add(objectId);
      result.push(objectId);
    }
  }
  return result;
}

function matchesType(index: GvqlGraphIndex, objectId: string, type: string | undefined): boolean {
  if (!type) return true;
  return index.nodes.get(objectId)?.type === type;
}

function matchesWhere(index: GvqlGraphIndex, binding: GvqlBinding, statement: GvqlStatement, parameters: Record<string, unknown>): boolean {
  if (!statement.where) return true;
  return evaluateBooleanExpression(statement.where, (predicate) => evaluatePredicate(index, binding, predicate, parameters));
}

function evaluateBooleanExpression<TPredicate>(
  expression: GvqlBooleanExpression<TPredicate>,
  evaluate: (predicate: TPredicate) => boolean,
): boolean {
  if (expression.kind === "predicate") return evaluate(expression.predicate);
  if (expression.kind === "not") return !evaluateBooleanExpression(expression.expression, evaluate);
  if (expression.operator === "AND") return evaluateBooleanExpression(expression.left, evaluate) && evaluateBooleanExpression(expression.right, evaluate);
  return evaluateBooleanExpression(expression.left, evaluate) || evaluateBooleanExpression(expression.right, evaluate);
}

function evaluatePredicate(
  index: GvqlGraphIndex,
  binding: GvqlBinding,
  predicate: GvqlPredicate,
  parameters: Record<string, unknown>,
): boolean {
  const left = evaluateGvqlValueExpression(index, binding, predicate.left, parameters, readPath);
  const right = evaluateGvqlValueExpression(index, binding, predicate.right, parameters, readPath);
  switch (predicate.operator) {
    case "=":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return compare(left, right) > 0;
    case ">=":
      return compare(left, right) >= 0;
    case "<":
      return compare(left, right) < 0;
    case "<=":
      return compare(left, right) <= 0;
    case "CONTAINS":
      return String(left ?? "").includes(String(right ?? ""));
    case "STARTS WITH":
      return String(left ?? "").startsWith(String(right ?? ""));
    case "ENDS WITH":
      return String(left ?? "").endsWith(String(right ?? ""));
    case "IN":
      return Array.isArray(right) && right.includes(left);
    case "IS NULL":
      return left === null || typeof left === "undefined";
    case "IS NOT NULL":
      return left !== null && typeof left !== "undefined";
  }
  return false;
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function applyBindingOrderingAndLimit(index: GvqlGraphIndex, bindings: GvqlBinding[], statement: GvqlStatement): GvqlBinding[] {
  return applyOffsetAndLimit(applyBindingOrdering(index, bindings, statement), statement);
}

function applyBindingOrdering(index: GvqlGraphIndex, bindings: GvqlBinding[], statement: GvqlStatement): GvqlBinding[] {
  const rows = [...bindings];
  const pathOrders = statement.orderBy?.filter((order) => order.expression.kind === "path") ?? [];
  if (pathOrders.length === statement.orderBy?.length) {
    rows.sort((a, b) => {
      for (const order of pathOrders) {
        if (order.expression.kind !== "path") continue;
        const comparison = compare(readPath(index, a, order.expression.expression), readPath(index, b, order.expression.expression));
        if (comparison !== 0) return order.direction === "desc" ? -comparison : comparison;
      }
      return 0;
    });
  }
  return rows;
}

function applyRowOrderingAndLimit(rows: Array<Record<string, unknown>>, statement: GvqlStatement): Array<Record<string, unknown>> {
  const ordered = [...rows];
  if (statement.orderBy?.length) {
    ordered.sort((a, b) => {
      for (const order of statement.orderBy ?? []) {
        const comparison =
          order.expression.kind === "alias"
            ? compare(a[order.expression.aliasName], b[order.expression.aliasName])
            : compare(a[rowKey(order.expression.expression)], b[rowKey(order.expression.expression)]);
        if (comparison !== 0) return order.direction === "desc" ? -comparison : comparison;
      }
      return 0;
    });
  }
  return applyOffsetAndLimit(ordered, statement);
}

function matchesHaving(row: Record<string, unknown>, statement: GvqlStatement, parameters: Record<string, unknown>): boolean {
  if (!statement.having) return true;
  return matchesRowBoolean(row, statement.having, parameters);
}

function matchesRowBoolean(row: Record<string, unknown>, expression: GvqlHavingClause | undefined, parameters: Record<string, unknown>): boolean {
  if (!expression) return true;
  return evaluateBooleanExpression(expression, (predicate) => evaluateRowPredicate(row, predicate, parameters));
}

function evaluateRowPredicate(row: Record<string, unknown>, predicate: GvqlRowPredicate, parameters: Record<string, unknown>): boolean {
  const left = row[predicate.left.aliasName];
  const right = isRowReference(predicate.right) ? row[predicate.right.aliasName] : literalToJs(predicate.right, parameters);
  switch (predicate.operator) {
    case "=":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return compare(left, right) > 0;
    case ">=":
      return compare(left, right) >= 0;
    case "<":
      return compare(left, right) < 0;
    case "<=":
      return compare(left, right) <= 0;
    case "CONTAINS":
      return String(left ?? "").includes(String(right ?? ""));
    case "STARTS WITH":
      return String(left ?? "").startsWith(String(right ?? ""));
    case "ENDS WITH":
      return String(left ?? "").endsWith(String(right ?? ""));
    case "IN":
      return Array.isArray(right) && right.includes(left);
    case "IS NULL":
      return left === null || typeof left === "undefined";
    case "IS NOT NULL":
      return left !== null && typeof left !== "undefined";
  }
  return false;
}

function readPath(index: GvqlGraphIndex, binding: GvqlBinding, expression: { alias: string; path?: string }): unknown {
  const objectId = binding[expression.alias];
  if (!objectId) return undefined;
  const node = index.envelope.nodes[objectId];
  if (!node) return undefined;
  if (!expression.path) return readNode(index, objectId);
  const metadata = readVirtualNodePath(index, objectId, expression.path);
  if (metadata.handled) return metadata.value;
  return encodedValueToJs(getNodePath(node, expression.path));
}

function readVirtualNodePath(index: GvqlGraphIndex, objectId: string, path: string): { handled: boolean; value?: unknown } {
  if (path === "$id") return { handled: true, value: objectId };
  const node = index.nodes.get(objectId);
  if (path === "$kind") return { handled: true, value: node?.kind };
  if (path === "$type") return { handled: true, value: node?.type };
  return { handled: false };
}

function readNode(index: GvqlGraphIndex, objectId: string | undefined): unknown {
  if (!objectId) return undefined;
  const node = index.envelope.nodes[objectId] as EncodedNode | undefined;
  if (!node) return undefined;
  const summary = nodeSummary(node);
  return summary && typeof summary === "object" && !Array.isArray(summary) ? { objectId, ...summary } : { objectId, value: summary };
}

function isPathExpression(value: unknown): value is GvqlPathExpression {
  return Boolean(value && typeof value === "object" && "alias" in value);
}

function isRowReference(value: unknown): value is { aliasName: string } {
  return Boolean(value && typeof value === "object" && "aliasName" in value);
}

function isAggregateStatement(statement: GvqlStatement): boolean {
  return Boolean(statement.groupBy?.length || statement.returns.some((item) => item.kind === "aggregate" || item.kind === "count"));
}

function hasAliasOrdering(statement: GvqlStatement): boolean {
  return Boolean(statement.orderBy?.some((order) => order.expression.kind === "alias"));
}

function rowKey(expression: { alias: string; path?: string }): string {
  return [expression.alias, expression.path].filter(Boolean).join(".");
}

function completePlan(plan: GvqlExecutionPlan, filteredBindings: GvqlBinding[], returnedRows: number, statement: GvqlStatement): GvqlExecutionPlan {
  const windowed = plan.offset > 0 || typeof plan.limit === "number";
  return {
    ...plan,
    filteredBindings: filteredBindings.length,
    returnedRows,
    operations: [
      ...plan.operations,
      ...(filteredBindings.length !== plan.matchedBindings ? ["where-filter"] : []),
      ...(plan.grouped ? ["aggregate"] : []),
      ...(plan.having ? ["having-filter"] : []),
      ...(statement.with ? ["with-project"] : []),
      ...(plan.distinct ? ["distinct"] : []),
      ...(windowed || returnedRows !== filteredBindings.length ? ["project-window"] : ["project"]),
    ],
  };
}

function distinctRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const result: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const key = stableStringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function indexablePredicates(
  statement: GvqlStatement,
  pattern: GvqlMatchPattern,
  parameters: Record<string, unknown>,
): IndexablePredicateSet | undefined {
  if (!statement.where) return undefined;
  const expression = statement.where;
  const mode = expression.kind === "predicate" ? "AND" : flattenLogicalPredicates(expression, "OR") ? "OR" : flattenLogicalPredicates(expression, "AND") ? "AND" : undefined;
  if (!mode) return undefined;
  const predicates = flattenLogicalPredicates(expression, mode) ?? [];
  const start = pattern.start;
  const result: IndexablePredicate[] = [];
  for (const predicate of predicates) {
    const left = predicate.left;
    if (!isPathExpression(left) || left.alias !== start.alias || !left.path || !isLiteralExpression(predicate.right)) continue;
    if (predicate.operator === "=") {
      const value = literalToJs(predicate.right, parameters);
      result.push({
        path: left.path,
        keyValues: [{ key: propertyIndexKey(start.type, left.path, value), value }],
      });
    } else if (predicate.operator === "IN") {
      const values = literalToJs(predicate.right, parameters);
      if (!Array.isArray(values) || values.length === 0) continue;
      result.push({
        path: left.path,
        keyValues: values.map((value) => ({ key: propertyIndexKey(start.type, left.path as string, value), value })),
      });
    }
  }
  if (mode === "OR" && result.length !== predicates.length) return undefined;
  return result.length > 0 ? { mode, predicates: result } : undefined;
}

function flattenLogicalPredicates(expression: GvqlBooleanExpression<GvqlPredicate>, operator: "AND" | "OR"): GvqlPredicate[] | undefined {
  if (expression.kind === "predicate") return [expression.predicate];
  if (expression.kind === "not") return undefined;
  if (expression.operator !== operator) return undefined;
  const left = flattenLogicalPredicates(expression.left, operator);
  const right = flattenLogicalPredicates(expression.right, operator);
  if (!left || !right) return undefined;
  return [...left, ...right];
}

function isLiteralExpression(value: GvqlValueExpression): value is GvqlLiteral {
  return !isPathExpression(value) && !(value && typeof value === "object" && "kind" in value);
}

function intersectCandidates(candidateLists: string[][]): Set<string> {
  const [first = [], ...rest] = candidateLists;
  const result = new Set(first);
  for (const candidates of rest) {
    const allowed = new Set(candidates);
    for (const objectId of result) {
      if (!allowed.has(objectId)) result.delete(objectId);
    }
  }
  return result;
}

function applyOffsetAndLimit<T>(items: T[], statement: GvqlStatement): T[] {
  const offset = statement.offset ?? 0;
  const start = Math.min(offset, items.length);
  const end = typeof statement.limit === "number" ? start + statement.limit : undefined;
  return items.slice(start, end);
}
