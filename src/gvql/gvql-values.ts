import type { EncodedNode, EncodedValue } from "../core/types.js";
import type { GvqlLiteral } from "./gvql-types.js";

export function encodedValueToJs(value: EncodedValue | undefined): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if ("$ref" in value) return { $ref: value.$ref };
  switch (value.$type) {
    case "undefined":
      return undefined;
    case "number":
      if (value.value === "NaN") return Number.NaN;
      if (value.value === "Infinity") return Infinity;
      if (value.value === "-Infinity") return -Infinity;
      return -0;
    case "bigint":
      return BigInt(value.value);
    case "date":
      return value.value;
    case "buffer":
    case "arraybuffer":
    case "sharedarraybuffer":
    case "dataview":
    case "typedarray":
      return value.value;
    case "regexp":
      return `/${value.source}/${value.flags}`;
    case "url":
    case "urlsearchparams":
      return value.value;
    case "symbol":
      return value.key ? `Symbol(${value.key})` : "Symbol()";
    case "error":
      return value.message;
  }
}

export function jsValueToEncoded(value: unknown): EncodedValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "undefined") {
    return { $type: "undefined" };
  }
  if (typeof value === "bigint") {
    return { $type: "bigint", value: value.toString() };
  }
  if (value instanceof Date) {
    return { $type: "date", value: value.toISOString() };
  }
  throw new Error("GVQL SET currently supports primitives, bigint, Date, null, and undefined.");
}

export function literalToJs(literal: GvqlLiteral, parameters: Record<string, unknown> = {}): unknown {
  if (Array.isArray(literal)) {
    return literal.map((item) => literalToJs(item, parameters));
  }
  if (literal && typeof literal === "object" && "parameter" in literal) {
    return parameters[literal.parameter];
  }
  return literal;
}

export function getNodePath(node: EncodedNode, path: string | undefined): EncodedValue | undefined {
  if (!path) {
    return nodeSummary(node) as EncodedValue;
  }
  if (node.kind === "object") {
    return node.props[path];
  }
  if (node.kind === "array" || node.kind === "set") {
    const index = arrayIndex(path);
    return index === undefined ? undefined : node.items[index];
  }
  if (node.kind === "map") {
    const match = /^entries\[(\d+)]\.(key|value)$/.exec(path);
    if (!match) return undefined;
    return node.entries[Number(match[1])]?.[match[2] === "key" ? 0 : 1];
  }
  return undefined;
}

export function setNodePath(node: EncodedNode, path: string | undefined, value: EncodedValue): void {
  if (!path) {
    throw new Error("GVQL SET requires an aliased property path, for example SET doc.status = \"archived\".");
  }
  if (node.kind === "object") {
    node.props[path] = value;
    return;
  }
  if (node.kind === "array" || node.kind === "set") {
    const index = arrayIndex(path);
    if (index === undefined) throw new Error(`Unsupported GVQL array path "${path}".`);
    node.items[index] = value;
    return;
  }
  if (node.kind === "map") {
    const match = /^entries\[(\d+)]\.(key|value)$/.exec(path);
    if (!match) throw new Error(`Unsupported GVQL map path "${path}".`);
    const entry = node.entries[Number(match[1])];
    if (!entry) throw new Error(`Unsupported GVQL map path "${path}".`);
    entry[match[2] === "key" ? 0 : 1] = value;
    return;
  }
  throw new Error(`GVQL cannot set fields on ${node.kind} nodes.`);
}

export function removeNodePath(node: EncodedNode, path: string | undefined): { before: EncodedValue | undefined; removed: boolean } {
  if (!path) {
    throw new Error("GVQL REMOVE requires an aliased property path, for example REMOVE doc.archivedAt.");
  }
  if (node.kind !== "object") {
    throw new Error(`GVQL REMOVE currently supports object fields, not ${node.kind} nodes.`);
  }
  if (!(path in node.props)) {
    return { before: undefined, removed: false };
  }
  const before = node.props[path];
  delete node.props[path];
  return { before, removed: true };
}

export function nodeSummary(node: EncodedNode): unknown {
  if (node.kind === "object") {
    const result: Record<string, unknown> = { kind: "object", ...(node.type ? { type: node.type } : {}) };
    for (const [key, value] of Object.entries(node.props).slice(0, 8)) {
      result[key] = encodedValueToJs(value);
    }
    return result;
  }
  if (node.kind === "array" || node.kind === "set") {
    return node.items.slice(0, 8).map(encodedValueToJs);
  }
  if (node.kind === "map") {
    return node.entries.slice(0, 8).map(([key, value]) => [encodedValueToJs(key), encodedValueToJs(value)]);
  }
  return { kind: "lazy", key: node.key };
}

function arrayIndex(path: string): number | undefined {
  const match = /^\[(\d+)]$/.exec(path);
  return match ? Number(match[1]) : undefined;
}
