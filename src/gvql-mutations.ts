import { encodedValueToJs, getNodePath, jsValueToEncoded, literalToJs, nodeSummary, removeNodePath, setNodePath } from "./gvql-values.js";
import type { EncodedNode, EncodedValue, SerializedEnvelope } from "./types.js";
import type {
  GvqlBinding,
  GvqlExecutionOptions,
  GvqlGraphIndex,
  GvqlMutationPreview,
  GvqlPathExpression,
  GvqlSetValueExpression,
  GvqlStatement,
} from "./gvql-types.js";

export type GvqlPathReader = (index: GvqlGraphIndex, binding: GvqlBinding, expression: GvqlPathExpression) => unknown;

export function applyGvqlMutations(
  index: GvqlGraphIndex,
  bindings: GvqlBinding[],
  statement: GvqlStatement,
  options: GvqlExecutionOptions,
  readPath: GvqlPathReader,
): GvqlMutationPreview[] {
  const changes: GvqlMutationPreview[] = [];
  changes.push(...applySet(index, bindings, statement, options, readPath));
  changes.push(...applyRemove(index, bindings, statement, options));
  changes.push(...applyDelete(index, bindings, statement, options));
  return changes;
}

function applySet(
  index: GvqlGraphIndex,
  bindings: GvqlBinding[],
  statement: GvqlStatement,
  options: GvqlExecutionOptions,
  readPath: GvqlPathReader,
): GvqlMutationPreview[] {
  const changes: GvqlMutationPreview[] = [];
  for (const binding of bindings) {
    for (const item of statement.set) {
      const objectId = binding[item.target.alias];
      if (!objectId) continue;
      const node = index.envelope.nodes[objectId];
      if (!node) continue;
      const beforeEncoded = getNodePath(node, item.target.path);
      const next = evaluateSetValue(index, binding, item.value, options.parameters ?? {}, readPath);
      const afterEncoded = jsValueToEncoded(next);
      changes.push({
        objectId,
        alias: item.target.alias,
        path: item.target.path ?? "",
        before: encodedValueToJs(beforeEncoded),
        after: encodedValueToJs(afterEncoded),
        operation: "set",
      });
      if (!options.dryRun) {
        setNodePath(node, item.target.path, afterEncoded);
      }
    }
  }
  return changes;
}

function evaluateSetValue(
  index: GvqlGraphIndex,
  binding: GvqlBinding,
  expression: GvqlSetValueExpression,
  parameters: Record<string, unknown>,
  readPath: GvqlPathReader,
): unknown {
  if (isBinarySetExpression(expression)) {
    const left = evaluateSetValue(index, binding, expression.left, parameters, readPath);
    const right = evaluateSetValue(index, binding, expression.right, parameters, readPath);
    if (typeof left !== "number" || typeof right !== "number") {
      throw new Error("GVQL arithmetic SET expressions require numeric operands.");
    }
    switch (expression.operator) {
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "*":
        return left * right;
      case "/":
        return left / right;
    }
  }
  return isPathExpression(expression) ? readPath(index, binding, expression) : literalToJs(expression, parameters);
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
        operation: "remove" as const,
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

function applyDelete(index: GvqlGraphIndex, bindings: GvqlBinding[], statement: GvqlStatement, options: GvqlExecutionOptions): GvqlMutationPreview[] {
  if (statement.delete.length === 0) return [];
  const targets = new Map<string, string>();
  for (const binding of bindings) {
    for (const item of statement.delete) {
      const objectId = binding[item.alias];
      if (objectId && index.envelope.nodes[objectId] && !targets.has(objectId)) {
        targets.set(objectId, item.alias);
      }
    }
  }
  const rootId = rootObjectId(index.envelope);
  if (rootId && targets.has(rootId)) {
    throw new Error("GVQL DELETE cannot delete the root object. Delete or replace a parent field instead.");
  }
  const targetIds = new Set(targets.keys());
  const changes: GvqlMutationPreview[] = [];
  const parentIds = new Set<string>();
  for (const targetId of targetIds) {
    for (const edge of index.incoming.get(targetId) ?? []) {
      if (targetIds.has(edge.from)) continue;
      const parentNode = index.envelope.nodes[edge.from];
      if (!parentNode) continue;
      parentIds.add(edge.from);
      changes.push({
        objectId: edge.from,
        alias: "$parent",
        path: edge.path,
        before: { $ref: targetId },
        after: undefined,
        operation: "detach",
      });
    }
  }
  for (const [targetId, alias] of targets) {
    const node = index.envelope.nodes[targetId];
    if (!node) continue;
    changes.push({
      objectId: targetId,
      alias,
      path: "",
      before: nodeSummary(node),
      after: undefined,
      operation: "delete",
    });
  }
  if (!options.dryRun) {
    for (const parentId of parentIds) {
      const parentNode = index.envelope.nodes[parentId];
      if (parentNode) detachReferencesTo(parentNode, targetIds);
    }
    for (const targetId of targetIds) {
      delete index.envelope.nodes[targetId];
    }
  }
  return changes;
}

function detachReferencesTo(node: EncodedNode, targetIds: Set<string>): void {
  if (node.kind === "array" || node.kind === "set") {
    node.items = node.items.filter((item) => !isReferenceTo(item, targetIds));
    return;
  }
  if (node.kind === "map") {
    node.entries = node.entries.filter(([key, value]) => !isReferenceTo(key, targetIds) && !isReferenceTo(value, targetIds));
    return;
  }
  if (node.kind === "object") {
    for (const [key, value] of Object.entries(node.props)) {
      if (isReferenceTo(value, targetIds)) {
        delete node.props[key];
      }
    }
    if (node.symbolProps) {
      node.symbolProps = node.symbolProps.filter(([key, value]) => !isReferenceTo(key, targetIds) && !isReferenceTo(value, targetIds));
    }
  }
}

function isReferenceTo(value: EncodedValue, targetIds: Set<string>): boolean {
  return Boolean(value && typeof value === "object" && "$ref" in value && targetIds.has(value.$ref));
}

function rootObjectId(envelope: SerializedEnvelope): string | undefined {
  return envelope.root && typeof envelope.root === "object" && "$ref" in envelope.root ? envelope.root.$ref : undefined;
}

function isPathExpression(value: unknown): value is GvqlPathExpression {
  return Boolean(value && typeof value === "object" && "alias" in value);
}

function isBinarySetExpression(value: unknown): value is Extract<GvqlSetValueExpression, { kind: "binary" }> {
  return Boolean(value && typeof value === "object" && "kind" in value && value.kind === "binary");
}
