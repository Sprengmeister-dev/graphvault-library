import { encodedValueToJs } from "./gvql-values.js";
import type { EncodedNode, EncodedValue, SerializedEnvelope } from "../core/types.js";
import type { GvqlGraphEdge, GvqlGraphIndex, GvqlGraphNode } from "./gvql-types.js";

export interface GvqlGraphIndexBuildOptions {
  propertyMode?: "all" | "configured";
  properties?: Array<{ type?: string; path: string }>;
  source?: GvqlGraphIndex["source"];
  transactionId?: number;
}

export function buildGvqlGraphIndex(envelope: SerializedEnvelope, options: GvqlGraphIndexBuildOptions = {}): GvqlGraphIndex {
  const nodes = new Map<string, GvqlGraphNode>();
  const byType = new Map<string, string[]>();
  const byProperty = new Map<string, string[]>();
  const outgoing = new Map<string, GvqlGraphEdge[]>();
  const incoming = new Map<string, GvqlGraphEdge[]>();
  const propertyMode = options.propertyMode ?? "all";
  const configuredProperties = configuredPropertyKeys(options.properties ?? []);
  const indexedPropertyKeys = new Set<string>();

  for (const [objectId, encoded] of Object.entries(envelope.nodes)) {
    const node: GvqlGraphNode = {
      objectId,
      kind: encoded.kind,
      ...(encoded.kind === "object" && encoded.type ? { type: encoded.type } : {}),
    };
    nodes.set(objectId, node);
    if (node.type) {
      const typed = byType.get(node.type) ?? [];
      typed.push(objectId);
      byType.set(node.type, typed);
    }
    if (encoded.kind === "object") {
      for (const [path, value] of Object.entries(encoded.props)) {
        if (!shouldIndexProperty(propertyMode, configuredProperties, node.type, path)) {
          continue;
        }
        indexProperty(byProperty, node.type, path, encodedValueToJs(value), objectId);
        addIndexedPropertyKeys(indexedPropertyKeys, node.type, path);
      }
    }

    for (const edge of referencedEdges(objectId, encoded)) {
      const fromList = outgoing.get(edge.from) ?? [];
      fromList.push(edge);
      outgoing.set(edge.from, fromList);
      const toList = incoming.get(edge.to) ?? [];
      toList.push(edge);
      incoming.set(edge.to, toList);
    }
  }

  return {
    envelope,
    nodes,
    byType,
    byProperty,
    outgoing,
    incoming,
    propertyIndexMode: propertyMode,
    indexedPropertyKeys,
    ...(options.source ? { source: options.source } : {}),
    ...(options.transactionId ? { transactionId: options.transactionId } : {}),
  };
}

export function propertyIndexKey(type: string | undefined, path: string, value: unknown): string {
  return `${type ?? "*"}\u0000${path}\u0000${stableValueKey(value)}`;
}

function indexProperty(byProperty: Map<string, string[]>, type: string | undefined, path: string, value: unknown, objectId: string): void {
  const keys = type ? [propertyIndexKey(type, path, value), propertyIndexKey(undefined, path, value)] : [propertyIndexKey(undefined, path, value)];
  for (const key of keys) {
    const indexed = byProperty.get(key) ?? [];
    indexed.push(objectId);
    byProperty.set(key, indexed);
  }
}

function configuredPropertyKeys(properties: Array<{ type?: string; path: string }>): Set<string> {
  const keys = new Set<string>();
  for (const property of properties) {
    keys.add(propertyKey(property.type, property.path));
  }
  return keys;
}

function shouldIndexProperty(propertyMode: "all" | "configured", configuredProperties: ReadonlySet<string>, type: string | undefined, path: string): boolean {
  return propertyMode === "all" || configuredProperties.has(propertyKey(type, path)) || configuredProperties.has(propertyKey(undefined, path));
}

function addIndexedPropertyKeys(keys: Set<string>, type: string | undefined, path: string): void {
  keys.add(propertyKey(undefined, path));
  if (type) {
    keys.add(propertyKey(type, path));
  }
}

export function propertyKey(type: string | undefined, path: string): string {
  return `${type ?? "*"}\u0000${path}`;
}

function stableValueKey(value: unknown): string {
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (value && typeof value === "object") return JSON.stringify(value);
  return `${typeof value}:${String(value)}`;
}

export function referencedEdges(from: string, node: EncodedNode): GvqlGraphEdge[] {
  const edges: GvqlGraphEdge[] = [];
  visitEncodedNode(node, (path, value) => {
    if (value && typeof value === "object" && "$ref" in value) {
      edges.push({ from, to: value.$ref, path, label: edgeLabel(path) });
    }
  });
  return edges;
}

export function visitEncodedNode(node: EncodedNode, visit: (path: string, value: EncodedValue) => void): void {
  if (node.kind === "array" || node.kind === "set") {
    node.items.forEach((value, index) => visit(`[${index}]`, value));
    return;
  }
  if (node.kind === "map") {
    node.entries.forEach(([key, value], index) => {
      visit(`entries[${index}].key`, key);
      visit(`entries[${index}].value`, value);
    });
    return;
  }
  if (node.kind === "object") {
    for (const [key, value] of Object.entries(node.props)) {
      visit(key, value);
    }
    node.symbolProps?.forEach(([key, value], index) => {
      visit(`symbolProps[${index}].key`, key);
      visit(`symbolProps[${index}].value`, value);
    });
  }
}

function edgeLabel(path: string): string {
  const bracket = path.indexOf("[");
  const dot = path.indexOf(".");
  const end = Math.min(...[bracket, dot].filter((value) => value >= 0));
  return Number.isFinite(end) ? path.slice(0, end) : path;
}
