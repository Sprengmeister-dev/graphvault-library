import { performance } from "node:perf_hooks";
import { projectGvqlRows } from "./gvql-aggregation.js";
import { buildGvqlGraphIndex, propertyIndexKey } from "./gvql-index.js";
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
  const parameters = options.parameters ?? {};
  const index = buildGvqlGraphIndex(envelope);
  const bindings = matchBindings(index, statement, parameters).filter((binding) => matchesWhere(index, binding, statement, parameters));
  const limitedBindings = applyOrderingAndLimit(index, bindings, statement);
  if (statement.kind === "select") {
    return {
      kind: "select",
      statement,
      rows: projectGvqlRows(index, limitedBindings, statement, readPath, readNode),
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
    rows: projectGvqlRows(index, limitedBindings, statement, readPath, readNode),
    matched: bindings.length,
    changed: changes.length,
    scannedObjects: index.nodes.size,
    elapsedMs: performance.now() - started,
    dryRun: options.dryRun ?? false,
    changes,
  };
}

export function matchBindings(index: GvqlGraphIndex, statement: GvqlStatement, parameters: Record<string, unknown> = {}): GvqlBinding[] {
  const firstCandidates = candidates(index, statement, parameters);
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

function candidates(index: GvqlGraphIndex, statement: GvqlStatement, parameters: Record<string, unknown>): string[] {
  const type = statement.match.start.type;
  const typeCandidates = type ? index.byType.get(type) ?? [] : Array.from(index.nodes.keys());
  const indexed = firstEqualityPredicate(statement, parameters);
  if (!indexed) return typeCandidates;
  const propertyCandidates = index.byProperty.get(indexed.key) ?? [];
  const allowed = new Set(propertyCandidates);
  return typeCandidates.filter((objectId) => allowed.has(objectId));
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

function firstEqualityPredicate(statement: GvqlStatement, parameters: Record<string, unknown>): { key: string } | undefined {
  const predicates = statement.where ? [statement.where.first, ...statement.where.rest.filter((item) => item.operator === "AND").map((item) => item.predicate)] : [];
  const start = statement.match.start;
  for (const predicate of predicates) {
    if (predicate.operator !== "=" || predicate.left.alias !== start.alias || !predicate.left.path || isPathExpression(predicate.right)) continue;
    const value = literalToJs(predicate.right, parameters);
    return { key: propertyIndexKey(start.type, predicate.left.path, value) };
  }
  return undefined;
}
