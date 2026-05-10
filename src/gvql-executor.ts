import { performance } from "node:perf_hooks";
import { projectGvqlRows } from "./gvql-aggregation.js";
import { buildGvqlGraphIndex, propertyIndexKey } from "./gvql-index.js";
import { encodedValueToJs, getNodePath, jsValueToEncoded, literalToJs, nodeSummary, removeNodePath, setNodePath } from "./gvql-values.js";
import type { EncodedNode, EncodedValue, SerializedEnvelope } from "./types.js";
import type {
  GvqlBinding,
  GvqlExecutionOptions,
  GvqlExecutionPlan,
  GvqlGraphEdge,
  GvqlGraphIndex,
  GvqlMutationPreview,
  GvqlPredicate,
  GvqlResult,
  GvqlRowPredicate,
  GvqlStatement,
} from "./gvql-types.js";

interface IndexedCandidateSelection {
  path: string;
  key: string;
  value: unknown;
  objectIds: string[];
  propertyIndexes: NonNullable<GvqlExecutionPlan["propertyIndexes"]>;
  operation: string;
}

export function executeGvqlStatement(envelope: SerializedEnvelope, statement: GvqlStatement, options: GvqlExecutionOptions = {}): GvqlResult {
  const started = performance.now();
  const parameters = options.parameters ?? {};
  const index = buildGvqlGraphIndex(envelope);
  const matched = matchBindingsWithPlan(index, statement, parameters);
  const bindings = matched.bindings.filter((binding) => matchesWhere(index, binding, statement, parameters));
  if (statement.kind === "select") {
    const rows = projectSelectRows(index, bindings, statement, parameters);
    const plan = completePlan(matched.plan, bindings, rows.length);
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
  const changes = applyMutations(index, limitedBindings, statement, options);
  const rows = projectGvqlRows(index, limitedBindings, statement, readPath, readNode);
  const plan = completePlan(matched.plan, bindings, rows.length);
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
  if (isAggregateStatement(statement) || statement.having || hasAliasOrdering(statement)) {
    const projected = projectGvqlRows(index, bindings, statement, readPath, readNode).filter((row) => matchesHaving(row, statement, parameters));
    const rows = statement.distinct ? distinctRows(projected) : projected;
    return applyRowOrderingAndLimit(rows, statement);
  }
  const orderedBindings = applyBindingOrdering(index, bindings, statement);
  if (statement.distinct) {
    const rows = distinctRows(projectGvqlRows(index, orderedBindings, statement, readPath, readNode));
    return applyOffsetAndLimit(rows, statement);
  }
  return projectGvqlRows(index, applyOffsetAndLimit(orderedBindings, statement), statement, readPath, readNode);
}

export function matchBindings(index: GvqlGraphIndex, statement: GvqlStatement, parameters: Record<string, unknown> = {}): GvqlBinding[] {
  return matchBindingsWithPlan(index, statement, parameters).bindings;
}

function matchBindingsWithPlan(
  index: GvqlGraphIndex,
  statement: GvqlStatement,
  parameters: Record<string, unknown> = {},
): { bindings: GvqlBinding[]; plan: GvqlExecutionPlan } {
  const selection = candidates(index, statement, parameters);
  const firstCandidates = selection.objectIds;
  let bindings = firstCandidates.map((objectId) => ({ [statement.match.start.alias]: objectId }));
  const operations = [...selection.operations];
  for (const link of statement.match.chain) {
    operations.push(`${link.edge.direction === "out" ? "traverse" : "reverse-traverse"}:${link.edge.label ?? "*"}`);
    const nextBindings: GvqlBinding[] = [];
    for (const binding of bindings) {
      const fromId = binding[previousAlias(statement, link)];
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
  return {
    bindings,
    plan: {
      nodeCount: index.nodes.size,
      candidateSource: selection.source,
      indexUsed: selection.source !== "full-scan",
      ...(statement.match.start.type ? { startType: statement.match.start.type } : {}),
      ...(selection.propertyIndex ? { propertyIndex: selection.propertyIndex } : {}),
      ...(selection.propertyIndexes ? { propertyIndexes: selection.propertyIndexes } : {}),
      startCandidates: firstCandidates.length,
      edgeSteps: statement.match.chain.length,
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

function previousAlias(statement: GvqlStatement, target: GvqlStatement["match"]["chain"][number]): string {
  let previous = statement.match.start.alias;
  for (const item of statement.match.chain) {
    if (item === target) return previous;
    previous = item.node.alias;
  }
  return previous;
}

function candidates(
  index: GvqlGraphIndex,
  statement: GvqlStatement,
  parameters: Record<string, unknown>,
): {
  objectIds: string[];
  source: GvqlExecutionPlan["candidateSource"];
  propertyIndex?: GvqlExecutionPlan["propertyIndex"];
  propertyIndexes?: GvqlExecutionPlan["propertyIndexes"];
  operations: string[];
} {
  const type = statement.match.start.type;
  const typeCandidates = type ? index.byType.get(type) ?? [] : Array.from(index.nodes.keys());
  const indexed = indexablePredicates(statement, parameters);
  if (indexed.length === 0) {
    return {
      objectIds: typeCandidates,
      source: type ? "type-index" : "full-scan",
      operations: [type ? `type-index:${type}` : "full-scan"],
    };
  }
  const indexedCandidates = indexed
    .map((item) => indexedCandidateSelection(index, item))
    .sort((a, b) => a.objectIds.length - b.objectIds.length);
  const allowed = intersectCandidates(indexedCandidates.map((item) => item.objectIds));
  const propertyIndexes = indexedCandidates.flatMap((item) => item.propertyIndexes);
  return {
    objectIds: typeCandidates.filter((objectId) => allowed.has(objectId)),
    source: "property-index",
    ...(propertyIndexes[0] ? { propertyIndex: { path: propertyIndexes[0].path, key: propertyIndexes[0].key, value: propertyIndexes[0].value } } : {}),
    propertyIndexes,
    operations: [
      ...indexedCandidates.map((item) => item.operation),
      ...(indexedCandidates.length > 1 ? [`property-index-intersect:${indexedCandidates.length}`] : []),
      ...(type ? [`type-filter:${type}`] : []),
    ],
  };
}

function indexedCandidateSelection(
  index: GvqlGraphIndex,
  item: { path: string; keyValues: Array<{ key: string; value: unknown }> },
): IndexedCandidateSelection {
  const keyedCandidates = item.keyValues.map(({ key, value }) => ({ key, value, objectIds: index.byProperty.get(key) ?? [] }));
  if (keyedCandidates.length === 1) {
    const only = keyedCandidates[0] as { key: string; value: unknown; objectIds: string[] };
    return {
      path: item.path,
      key: only.key,
      value: only.value,
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
    key: keyedCandidates.map((candidate) => candidate.key).join("|"),
    value: keyedCandidates.map((candidate) => candidate.value),
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

function matchesType(index: GvqlGraphIndex, objectId: string, type: string | undefined): boolean {
  if (!type) return true;
  return index.nodes.get(objectId)?.type === type;
}

function matchesWhere(index: GvqlGraphIndex, binding: GvqlBinding, statement: GvqlStatement, parameters: Record<string, unknown>): boolean {
  if (!statement.where) return true;
  let result = evaluatePredicate(index, binding, statement.where.first, parameters);
  for (const item of statement.where.rest) {
    if (item.operator === "AND") result = result && evaluatePredicate(index, binding, item.predicate, parameters);
    else result = result || evaluatePredicate(index, binding, item.predicate, parameters);
  }
  return result;
}

function evaluatePredicate(
  index: GvqlGraphIndex,
  binding: GvqlBinding,
  predicate: GvqlPredicate,
  parameters: Record<string, unknown>,
): boolean {
  const left = readPath(index, binding, predicate.left);
  const right = isPathExpression(predicate.right) ? readPath(index, binding, predicate.right) : literalToJs(predicate.right, parameters);
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
  let result = evaluateRowPredicate(row, statement.having.first, parameters);
  for (const item of statement.having.rest) {
    if (item.operator === "AND") result = result && evaluateRowPredicate(row, item.predicate, parameters);
    else result = result || evaluateRowPredicate(row, item.predicate, parameters);
  }
  return result;
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

function applyMutations(index: GvqlGraphIndex, bindings: GvqlBinding[], statement: GvqlStatement, options: GvqlExecutionOptions): GvqlMutationPreview[] {
  const changes: GvqlMutationPreview[] = [];
  changes.push(...applySet(index, bindings, statement, options));
  changes.push(...applyRemove(index, bindings, statement, options));
  return changes;
}

function applySet(index: GvqlGraphIndex, bindings: GvqlBinding[], statement: GvqlStatement, options: GvqlExecutionOptions): GvqlMutationPreview[] {
  const changes: GvqlMutationPreview[] = [];
  for (const binding of bindings) {
    for (const item of statement.set) {
      const objectId = binding[item.target.alias];
      if (!objectId) continue;
      const node = objectId ? index.envelope.nodes[objectId] : undefined;
      if (!node) continue;
      const beforeEncoded = getNodePath(node, item.target.path);
      const next = isPathExpression(item.value) ? readPath(index, binding, item.value) : literalToJs(item.value, options.parameters ?? {});
      const afterEncoded = jsValueToEncoded(next);
      changes.push({
        objectId: objectId,
        alias: item.target.alias,
        path: item.target.path ?? "",
        before: encodedValueToJs(beforeEncoded),
        after: encodedValueToJs(afterEncoded),
      });
      if (!options.dryRun) {
        setNodePath(node, item.target.path, afterEncoded);
      }
    }
  }
  return changes;
}

function applyRemove(index: GvqlGraphIndex, bindings: GvqlBinding[], statement: GvqlStatement, options: GvqlExecutionOptions): GvqlMutationPreview[] {
  const changes: GvqlMutationPreview[] = [];
  for (const binding of bindings) {
    for (const item of statement.remove) {
      const objectId = binding[item.target.alias];
      if (!objectId) continue;
      const node = index.envelope.nodes[objectId];
      if (!node) continue;
      if (node.kind !== "object") {
        throw new Error(`GVQL REMOVE currently supports object fields, not ${node.kind} nodes.`);
      }
      const beforeEncoded = getNodePath(node, item.target.path);
      const preview = {
        objectId,
        alias: item.target.alias,
        path: item.target.path ?? "",
        before: encodedValueToJs(beforeEncoded),
        after: undefined,
      };
      if (options.dryRun) {
        if (typeof beforeEncoded !== "undefined") changes.push(preview);
        continue;
      }
      const removed = removeNodePath(node, item.target.path);
      if (removed.removed) changes.push(preview);
    }
  }
  return changes;
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

function isPathExpression(value: unknown): value is { alias: string; path?: string } {
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

function completePlan(plan: GvqlExecutionPlan, filteredBindings: GvqlBinding[], returnedRows: number): GvqlExecutionPlan {
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
  parameters: Record<string, unknown>,
): Array<{ path: string; keyValues: Array<{ key: string; value: unknown }> }> {
  if (!statement.where || statement.where.rest.some((item) => item.operator === "OR")) return [];
  const predicates = [statement.where.first, ...statement.where.rest.map((item) => item.predicate)];
  const start = statement.match.start;
  const result: Array<{ path: string; keyValues: Array<{ key: string; value: unknown }> }> = [];
  for (const predicate of predicates) {
    if (predicate.left.alias !== start.alias || !predicate.left.path || isPathExpression(predicate.right)) continue;
    if (predicate.operator === "=") {
      const value = literalToJs(predicate.right, parameters);
      result.push({
        path: predicate.left.path,
        keyValues: [{ key: propertyIndexKey(start.type, predicate.left.path, value), value }],
      });
    } else if (predicate.operator === "IN") {
      const values = literalToJs(predicate.right, parameters);
      if (!Array.isArray(values) || values.length === 0) continue;
      result.push({
        path: predicate.left.path,
        keyValues: values.map((value) => ({ key: propertyIndexKey(start.type, predicate.left.path as string, value), value })),
      });
    }
  }
  return result;
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
