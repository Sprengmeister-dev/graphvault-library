import { performance } from "node:perf_hooks";
import { buildGvqlGraphIndex } from "./gvql-index.js";
import { encodedValueToJs, getNodePath, jsValueToEncoded, literalToJs, nodeSummary, setNodePath } from "./gvql-values.js";
import type { EncodedNode, EncodedValue, SerializedEnvelope } from "./types.js";
import type {
  GvqlBinding,
  GvqlExecutionOptions,
  GvqlGraphEdge,
  GvqlGraphIndex,
  GvqlMutationPreview,
  GvqlPredicate,
  GvqlResult,
  GvqlStatement,
} from "./gvql-types.js";

export function executeGvqlStatement(envelope: SerializedEnvelope, statement: GvqlStatement, options: GvqlExecutionOptions = {}): GvqlResult {
  const started = performance.now();
  const index = buildGvqlGraphIndex(envelope);
  const bindings = matchBindings(index, statement).filter((binding) => matchesWhere(index, binding, statement, options.parameters ?? {}));
  const limitedBindings = applyOrderingAndLimit(index, bindings, statement);
  if (statement.kind === "select") {
    return {
      kind: "select",
      statement,
      rows: projectRows(index, limitedBindings, statement, options.parameters ?? {}),
      matched: bindings.length,
      scannedObjects: index.nodes.size,
      elapsedMs: performance.now() - started,
    };
  }
  if (!options.allowMutations && !options.dryRun) {
    throw new Error("GVQL update statements require allowMutations.");
  }
  const changes = applySet(index, limitedBindings, statement, options);
  return {
    kind: "update",
    statement,
    rows: projectRows(index, limitedBindings, statement, options.parameters ?? {}),
    matched: bindings.length,
    changed: changes.length,
    scannedObjects: index.nodes.size,
    elapsedMs: performance.now() - started,
    dryRun: options.dryRun ?? false,
    changes,
  };
}

export function matchBindings(index: GvqlGraphIndex, statement: GvqlStatement): GvqlBinding[] {
  const firstCandidates = candidates(index, statement.match.start.type);
  let bindings = firstCandidates.map((objectId) => ({ [statement.match.start.alias]: objectId }));
  for (const link of statement.match.chain) {
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
  return bindings;
}

function previousAlias(statement: GvqlStatement, target: GvqlStatement["match"]["chain"][number]): string {
  let previous = statement.match.start.alias;
  for (const item of statement.match.chain) {
    if (item === target) return previous;
    previous = item.node.alias;
  }
  return previous;
}

function candidates(index: GvqlGraphIndex, type: string | undefined): string[] {
  return type ? index.byType.get(type) ?? [] : Array.from(index.nodes.keys());
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
  }
  return false;
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function applyOrderingAndLimit(index: GvqlGraphIndex, bindings: GvqlBinding[], statement: GvqlStatement): GvqlBinding[] {
  const rows = [...bindings];
  if (statement.orderBy) {
    const order = statement.orderBy;
    rows.sort((a, b) => {
      const comparison = compare(readPath(index, a, order.expression), readPath(index, b, order.expression));
      return order.direction === "desc" ? -comparison : comparison;
    });
  }
  return typeof statement.limit === "number" ? rows.slice(0, statement.limit) : rows;
}

function projectRows(
  index: GvqlGraphIndex,
  bindings: GvqlBinding[],
  statement: GvqlStatement,
  parameters: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const firstReturn = statement.returns[0];
  if (statement.returns.length === 1 && firstReturn?.kind === "count") {
    return [{ [firstReturn.aliasName ?? "count"]: bindings.length }];
  }
  return bindings.map((binding) => {
    const row: Record<string, unknown> = {};
    for (const item of statement.returns) {
      if (item.kind === "count") {
        row[item.aliasName ?? "count"] = bindings.length;
      } else if (item.kind === "all") {
        if (item.alias) row[item.aliasName ?? item.alias] = readNode(index, binding[item.alias]);
        else row[item.aliasName ?? "*"] = Object.fromEntries(Object.entries(binding).map(([alias, objectId]) => [alias, readNode(index, objectId)]));
      } else {
        row[item.aliasName ?? [item.expression.alias, item.expression.path].filter(Boolean).join(".")] = readPath(index, binding, item.expression);
      }
    }
    return row;
  });
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

function readPath(index: GvqlGraphIndex, binding: GvqlBinding, expression: { alias: string; path?: string }): unknown {
  const objectId = binding[expression.alias];
  if (!objectId) return undefined;
  const node = index.envelope.nodes[objectId];
  if (!node) return undefined;
  if (!expression.path) return readNode(index, objectId);
  return encodedValueToJs(getNodePath(node, expression.path));
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
