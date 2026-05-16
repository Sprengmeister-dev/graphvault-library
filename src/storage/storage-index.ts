import { createHash } from "node:crypto";
import { buildGvqlGraphIndex } from "../gvql/gvql-index.js";
import { advancedIndexFromRecord, buildAdvancedIndexRecord, type AdvancedIndexOptions } from "../gvql/gvql-advanced-index.js";
import type { GvqlGraphIndex, GvqlGraphEdge, GvqlGraphNode } from "../gvql/gvql-types.js";
import type {
  SerializedEnvelope,
  StorageCompositeIndexDefinition,
  StorageExpressionIndexDefinition,
  StorageIndexDefinition,
  StorageIndexOptions,
  StorageIndexRecord,
  StorageIndexStatus,
  StorageUniqueIndexDefinition,
} from "../core/types.js";

export interface ResolvedStorageIndexOptions {
  mode: "off" | "auto" | "configured";
  consistency: "strict" | "committed";
  properties: StorageIndexDefinition[];
  advanced: AdvancedIndexOptions;
}

export function resolveStorageIndexOptions(options: boolean | StorageIndexOptions | undefined): ResolvedStorageIndexOptions {
  if (options === false) {
    return { mode: "off", consistency: "strict", properties: [], advanced: emptyAdvancedOptions() };
  }
  if (options === true || !options) {
    return { mode: "auto", consistency: "strict", properties: [], advanced: emptyAdvancedOptions() };
  }
  const advanced = normalizeAdvancedOptions(options);
  const hasConfigured = Boolean(options.properties?.length || advanced.composites.length || advanced.ranges.length || advanced.text.length || advanced.fullText.length || advanced.unique.length || advanced.expressions.length);
  const mode = options.mode ?? (hasConfigured ? "configured" : "auto");
  return {
    mode,
    consistency: options.consistency ?? "strict",
    properties: normalizeIndexDefinitions(options.properties ?? []),
    advanced,
  };
}

export function buildStorageIndexRecord(
  envelope: SerializedEnvelope,
  transactionId: number,
  options: ResolvedStorageIndexOptions,
): StorageIndexRecord | undefined {
  if (options.mode === "off") {
    return undefined;
  }
  const mode = options.mode === "configured" ? "configured" : "auto";
  const index = buildGvqlGraphIndex(envelope, {
    propertyMode: mode === "configured" ? "configured" : "all",
    properties: options.properties,
    source: "persistent",
    transactionId,
  });
  const advanced = buildAdvancedIndexRecord(envelope, options.advanced);
  return {
    format: "graphvault-index",
    version: 2,
    transactionId,
    createdAt: new Date().toISOString(),
    envelopeHash: indexEnvelopeHash(envelope),
    nodeCount: index.nodes.size,
    mode,
    indexedProperties: options.properties,
    byType: mapToRecord(index.byType),
    byProperty: mapToRecord(index.byProperty),
    outgoing: edgeMapToRecord(index.outgoing),
    incoming: edgeMapToRecord(index.incoming),
    ...(advanced ? { advanced } : {}),
  };
}

export function graphIndexFromStorageRecord(envelope: SerializedEnvelope, record: StorageIndexRecord): GvqlGraphIndex {
  const indexedPropertyKeys = new Set<string>();
  for (const key of Object.keys(record.byProperty)) {
    const [type = "*", path = ""] = key.split("\u0000", 2);
    indexedPropertyKeys.add(`${type}\u0000${path}`);
  }
  const advanced = advancedIndexFromRecord(record.advanced);
  return {
    envelope,
    nodes: nodesFromEnvelope(envelope),
    byType: recordToMap(record.byType),
    byProperty: recordToMap(record.byProperty),
    outgoing: edgeRecordToMap(record.outgoing),
    incoming: edgeRecordToMap(record.incoming),
    ...(advanced ? { advanced } : {}),
    propertyIndexMode: record.mode === "configured" ? "configured" : "all",
    indexedPropertyKeys,
    source: "persistent",
    transactionId: record.transactionId,
  };
}

export function storageIndexStatus(input: {
  options: ResolvedStorageIndexOptions;
  record: StorageIndexRecord | undefined;
  transactionId: number;
}): StorageIndexStatus {
  if (input.options.mode === "off") {
    return { enabled: false, mode: "off", consistency: input.options.consistency, nodeCount: 0, propertyKeys: 0, edgeCount: 0, source: "disabled" };
  }
  if (!input.record) {
    return {
      enabled: true,
      mode: input.options.mode,
      consistency: input.options.consistency,
      nodeCount: 0,
      propertyKeys: 0,
      edgeCount: 0,
      source: "missing",
    };
  }
  return {
    enabled: true,
    mode: input.options.mode,
    consistency: input.options.consistency,
    transactionId: input.record.transactionId,
    nodeCount: input.record.nodeCount,
    propertyKeys: Object.keys(input.record.byProperty).length,
    edgeCount: edgeCount(input.record),
    ...advancedStatus(input.record),
    source: input.record.transactionId === input.transactionId ? "storage" : "stale",
  };
}

export function isUsableStorageIndexRecord(record: StorageIndexRecord | undefined, envelope: SerializedEnvelope, transactionId: number): record is StorageIndexRecord {
  return Boolean(record && record.transactionId === transactionId && record.envelopeHash === indexEnvelopeHash(envelope));
}

export function indexEnvelopeHash(envelope: SerializedEnvelope): string {
  return createHash("sha256")
    .update(JSON.stringify({ format: envelope.format, version: envelope.version, root: envelope.root, nodes: envelope.nodes }))
    .digest("hex");
}

function normalizeIndexDefinitions(properties: Array<string | StorageIndexDefinition>): StorageIndexDefinition[] {
  const seen = new Set<string>();
  const normalized: StorageIndexDefinition[] = [];
  for (const property of properties) {
    const definition = typeof property === "string" ? { path: property } : property;
    const key = `${definition.type ?? "*"}\u0000${definition.path}`;
    if (!definition.path || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(definition.type ? { type: definition.type, path: definition.path } : { path: definition.path });
  }
  return normalized;
}

function normalizeAdvancedOptions(options: StorageIndexOptions): AdvancedIndexOptions {
  return {
    composites: normalizeComposites(options.composites ?? []),
    ranges: normalizePathDefinitions(options.ranges ?? []),
    text: normalizePathDefinitions(options.text ?? []).map((item) => ({ minGram: 2, maxGram: 4, ...item })),
    fullText: normalizePathDefinitions(options.fullText ?? []),
    unique: normalizeUniqueDefinitions(options.unique ?? []),
    expressions: normalizeExpressionDefinitions(options.expressions ?? []),
  };
}

function emptyAdvancedOptions(): AdvancedIndexOptions {
  return { composites: [], ranges: [], text: [], fullText: [], unique: [], expressions: [] };
}

function normalizeComposites(items: StorageCompositeIndexDefinition[]): StorageCompositeIndexDefinition[] {
  return items.filter((item) => item.paths.length > 1).map((item) => ({ ...item, paths: [...new Set(item.paths)] }));
}

function normalizePathDefinitions<T extends StorageIndexDefinition>(items: Array<string | T>): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const definition = typeof item === "string" ? ({ path: item } as T) : item;
    const key = `${definition.type ?? "*"}\u0000${definition.path}`;
    if (!definition.path || seen.has(key)) continue;
    seen.add(key);
    result.push(definition);
  }
  return result;
}

function normalizeUniqueDefinitions(items: Array<string | StorageUniqueIndexDefinition>): StorageUniqueIndexDefinition[] {
  return items
    .map((item) => typeof item === "string" ? { path: item } : item)
    .filter((item) => item.path || item.paths?.length)
    .map((item) => ({ ...item, paths: item.paths ?? (item.path ? [item.path] : []) }));
}

function normalizeExpressionDefinitions(items: StorageExpressionIndexDefinition[]): StorageExpressionIndexDefinition[] {
  return items.filter((item) => item.expression.path);
}

function advancedStatus(record: StorageIndexRecord): Partial<StorageIndexStatus> {
  const advanced = record.advanced;
  if (!advanced) return {};
  return {
    advancedIndexes: advanced.definitions.length,
    compositeKeys: countKeys(advanced.composite),
    rangeKeys: Object.values(advanced.range).reduce((count, entries) => count + entries.length, 0),
    textTerms: countKeys(advanced.text),
    fullTextTerms: countKeys(advanced.fullText),
    expressionKeys: countKeys(advanced.expression),
    uniqueKeys: countKeys(advanced.unique),
  };
}

function countKeys(record: Record<string, Record<string, unknown>>): number {
  return Object.values(record).reduce((count, bucket) => count + Object.keys(bucket).length, 0);
}

function nodesFromEnvelope(envelope: SerializedEnvelope): Map<string, GvqlGraphNode> {
  const nodes = new Map<string, GvqlGraphNode>();
  for (const [objectId, encoded] of Object.entries(envelope.nodes)) {
    nodes.set(objectId, {
      objectId,
      kind: encoded.kind,
      ...(encoded.kind === "object" && encoded.type ? { type: encoded.type } : {}),
    });
  }
  return nodes;
}

function mapToRecord(map: ReadonlyMap<string, readonly string[]>): Record<string, string[]> {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, [...value]]));
}

function recordToMap(record: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(record).map(([key, value]) => [key, [...value]]));
}

function edgeMapToRecord(map: ReadonlyMap<string, readonly GvqlGraphEdge[]>): Record<string, GvqlGraphEdge[]> {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, value.map((edge) => ({ ...edge }))]));
}

function edgeRecordToMap(record: Record<string, GvqlGraphEdge[]>): Map<string, GvqlGraphEdge[]> {
  return new Map(Object.entries(record).map(([key, value]) => [key, value.map((edge) => ({ ...edge }))]));
}

function edgeCount(record: StorageIndexRecord): number {
  return Object.values(record.outgoing).reduce((count, edges) => count + edges.length, 0);
}
