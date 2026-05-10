import { evaluateGvqlValueExpression } from "./gvql-expressions.js";
import { encodedValueToJs, getNodePath, jsValueToEncoded, nodeSummary, removeNodePath, setNodePath } from "./gvql-values.js";
import type { EncodedNode, EncodedValue, SerializedEnvelope } from "../core/types.js";
import type {
  GvqlBinding,
  GvqlExecutionOptions,
  GvqlGraphIndex,
  GvqlMutationPreview,
  GvqlStatement,
} from "./gvql-types.js";
import type { GvqlPathReader } from "./gvql-expressions.js";

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
  changes.push(...applyCreate(index, bindings, statement, options, readPath));
  changes.push(...applyMerge(index, bindings, statement, options, readPath));
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
      const next = evaluateGvqlValueExpression(index, binding, item.value, options.parameters ?? {}, readPath);
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

function applyCreate(
  index: GvqlGraphIndex,
  bindings: GvqlBinding[],
  statement: GvqlStatement,
  options: GvqlExecutionOptions,
  readPath: GvqlPathReader,
): GvqlMutationPreview[] {
  if (statement.create.length === 0) return [];
  const changes: GvqlMutationPreview[] = [];
  for (const binding of bindings) {
    for (const item of statement.create) {
      const objectId = nextObjectId(index.envelope);
      const props: EncodedNode & { kind: "object" } = {
        kind: "object",
        ...(item.type ? { type: item.type, version: 1 } : {}),
        props: Object.fromEntries(
          Object.entries(item.props).map(([key, expression]) => [
            key,
            jsValueToEncoded(evaluateGvqlValueExpression(index, binding, expression, options.parameters ?? {}, readPath)),
          ]),
        ),
      };
      index.envelope.nodes[objectId] = props;
      binding[item.alias] = objectId;
      changes.push({
        objectId,
        alias: item.alias,
        path: "",
        before: undefined,
        after: nodeSummary(props),
        operation: "create",
      });
      changes.push(...attachCreatedObject(index, binding, item.into, objectId));
    }
  }
  return changes;
}

function applyMerge(
  index: GvqlGraphIndex,
  bindings: GvqlBinding[],
  statement: GvqlStatement,
  options: GvqlExecutionOptions,
  readPath: GvqlPathReader,
): GvqlMutationPreview[] {
  if (statement.merge.length === 0) return [];
  const changes: GvqlMutationPreview[] = [];
  for (const binding of bindings) {
    for (const item of statement.merge) {
      const onPath = item.on.path;
      if (!onPath) throw new Error(`GVQL MERGE ON must include a property path for alias "${item.alias}".`);
      const props = evaluateProps(index, binding, item.props, options, readPath);
      const matchValue = encodedValueToJs(getNodePath({ kind: "object", props }, onPath));
      if (typeof matchValue === "undefined") {
        throw new Error(`GVQL MERGE ON path "${item.on.alias}.${onPath}" must be present in the MERGE properties.`);
      }
      const existing = findMergeTarget(index, binding, item.into, onPath, matchValue);
      if (existing) {
        binding[item.alias] = existing;
        continue;
      }
      const objectId = nextObjectId(index.envelope);
      const node: EncodedNode & { kind: "object" } = {
        kind: "object",
        ...(item.type ? { type: item.type, version: 1 } : {}),
        props,
      };
      index.envelope.nodes[objectId] = node;
      binding[item.alias] = objectId;
      changes.push({
        objectId,
        alias: item.alias,
        path: onPath,
        before: undefined,
        after: nodeSummary(node),
        operation: "merge",
      });
      changes.push(...attachCreatedObject(index, binding, item.into, objectId));
    }
  }
  return changes;
}

function evaluateProps(
  index: GvqlGraphIndex,
  binding: GvqlBinding,
  props: Record<string, Parameters<typeof evaluateGvqlValueExpression>[2]>,
  options: GvqlExecutionOptions,
  readPath: GvqlPathReader,
): Record<string, EncodedValue> {
  return Object.fromEntries(
    Object.entries(props).map(([key, expression]) => [
      key,
      jsValueToEncoded(evaluateGvqlValueExpression(index, binding, expression, options.parameters ?? {}, readPath)),
    ]),
  );
}

function findMergeTarget(
  index: GvqlGraphIndex,
  binding: GvqlBinding,
  target: { alias: string; path?: string },
  onPath: string,
  expected: unknown,
): string | undefined {
  const collection = resolveCollection(index, binding, target);
  const candidates = collection.kind === "array" || collection.kind === "set" ? collection.items : [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || !("$ref" in candidate)) continue;
    const node = index.envelope.nodes[candidate.$ref];
    if (!node) continue;
    if (sameMergeValue(encodedValueToJs(getNodePath(node, onPath)), expected)) return candidate.$ref;
  }
  return undefined;
}

function resolveCollection(index: GvqlGraphIndex, binding: GvqlBinding, target: { alias: string; path?: string }): EncodedNode {
  const parentId = binding[target.alias];
  if (!parentId) throw new Error(`GVQL MERGE INTO alias "${target.alias}" is not bound.`);
  const parentNode = index.envelope.nodes[parentId];
  if (!parentNode) throw new Error(`GVQL MERGE INTO parent "${target.alias}" does not exist.`);
  if (!target.path) return parentNode;
  const existing = getNodePath(parentNode, target.path);
  if (existing && typeof existing === "object" && "$ref" in existing) {
    const collection = index.envelope.nodes[existing.$ref];
    if (!collection) throw new Error(`GVQL MERGE INTO target "${target.alias}.${target.path}" points to a missing node.`);
    return collection;
  }
  if (typeof existing === "undefined") return { kind: "array", items: [] };
  throw new Error(`GVQL MERGE INTO requires an array or set target at "${target.alias}.${target.path}".`);
}

function sameMergeValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function attachCreatedObject(index: GvqlGraphIndex, binding: GvqlBinding, target: { alias: string; path?: string }, objectId: string): GvqlMutationPreview[] {
  const parentId = binding[target.alias];
  if (!parentId) throw new Error(`GVQL CREATE INTO alias "${target.alias}" is not bound.`);
  const parentNode = index.envelope.nodes[parentId];
  if (!parentNode) throw new Error(`GVQL CREATE INTO parent "${target.alias}" does not exist.`);
  const reference: EncodedValue = { $ref: objectId };
  if (!target.path) {
    appendToCollection(parentNode, reference, target.alias);
    return [{ objectId: parentId, alias: target.alias, path: "", before: undefined, after: { $ref: objectId }, operation: "attach" }];
  }
  const existing = getNodePath(parentNode, target.path);
  if (existing && typeof existing === "object" && "$ref" in existing) {
    const collection = index.envelope.nodes[existing.$ref];
    if (!collection) throw new Error(`GVQL CREATE INTO target "${target.alias}.${target.path}" points to a missing node.`);
    appendToCollection(collection, reference, `${target.alias}.${target.path}`);
    return [{ objectId: existing.$ref, alias: target.alias, path: target.path, before: undefined, after: { $ref: objectId }, operation: "attach" }];
  }
  if (typeof existing === "undefined" && parentNode.kind === "object") {
    const collectionId = nextObjectId(index.envelope);
    index.envelope.nodes[collectionId] = { kind: "array", items: [reference] };
    parentNode.props[target.path] = { $ref: collectionId };
    return [
      { objectId: collectionId, alias: "$collection", path: "", before: undefined, after: [], operation: "create" },
      { objectId: parentId, alias: target.alias, path: target.path, before: undefined, after: { $ref: collectionId }, operation: "attach" },
    ];
  }
  throw new Error(`GVQL CREATE INTO requires an array or set target at "${target.alias}.${target.path}".`);
}

function appendToCollection(node: EncodedNode, reference: EncodedValue, label: string): void {
  if (node.kind === "array" || node.kind === "set") {
    node.items.push(reference);
    return;
  }
  throw new Error(`GVQL CREATE INTO requires an array or set target at "${label}".`);
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

function nextObjectId(envelope: SerializedEnvelope): string {
  const highest = Object.keys(envelope.nodes).reduce((max, objectId) => {
    const numeric = Number(objectId);
    return Number.isSafeInteger(numeric) ? Math.max(max, numeric) : max;
  }, 0);
  let candidate = highest + 1;
  while (envelope.nodes[String(candidate)]) candidate++;
  return String(candidate);
}
