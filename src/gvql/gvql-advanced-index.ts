import { encodedValueToJs, getNodePath } from "./gvql-values.js";
import { indexStatistics, stableIndexValueKey, textIndexTerms, tokenizeIndexText, tupleIndexKey } from "./gvql-index-keys.js";
import type {
  EncodedNode,
  SerializedEnvelope,
  StorageAdvancedIndexDefinitionRecord,
  StorageAdvancedIndexRecord,
  StorageCompositeIndexDefinition,
  StorageExpressionIndexDefinition,
  StorageFullTextIndexDefinition,
  StorageIndexCondition,
  StorageRangeIndexDefinition,
  StorageTextIndexDefinition,
  StorageUniqueIndexDefinition,
} from "../core/types.js";
import type { GvqlAdvancedGraphIndex } from "./gvql-types.js";

export interface AdvancedIndexOptions {
  composites: StorageCompositeIndexDefinition[];
  ranges: StorageRangeIndexDefinition[];
  text: StorageTextIndexDefinition[];
  fullText: StorageFullTextIndexDefinition[];
  unique: StorageUniqueIndexDefinition[];
  expressions: StorageExpressionIndexDefinition[];
}

export function buildAdvancedIndexRecord(envelope: SerializedEnvelope, options: AdvancedIndexOptions): StorageAdvancedIndexRecord | undefined {
  const definitions = advancedDefinitions(options);
  if (definitions.length === 0) return undefined;
  const composite = new Map<string, Map<string, string[]>>();
  const range = new Map<string, Map<string, { raw: unknown; objectIds: string[] }>>();
  const text = new Map<string, Map<string, string[]>>();
  const fullText = new Map<string, Map<string, string[]>>();
  const expression = new Map<string, Map<string, string[]>>();
  const unique = new Map<string, Map<string, string>>();

  for (const [objectId, node] of Object.entries(envelope.nodes)) {
    if (node.kind !== "object") continue;
    for (const definition of definitions) {
      if (!definitionMatches(definition, node)) continue;
      if (definition.partial && !matchesCondition(node, definition.partial)) continue;
      const values = valuesForDefinition(node, definition);
      if (!values.length || (definition.sparse && values.some(isMissing))) continue;
      if (definition.kind === "range") addRange(range, definition.name, values[0], objectId);
      else if (definition.kind === "text") addTerms(text, definition.name, textIndexTerms(values[0], definition), objectId);
      else if (definition.kind === "fullText") addTerms(fullText, definition.name, tokenizeIndexText(values[0], definition.caseSensitive), objectId);
      else if (definition.kind === "expression") addBucket(expression, definition.name, stableIndexValueKey(values[0]), objectId);
      else if (definition.kind === "unique") addUnique(unique, definition.name, tupleIndexKey(values), objectId);
      else {
        addBucket(composite, definition.name, tupleIndexKey(values), objectId);
        if (definition.unique) addUnique(unique, definition.name, tupleIndexKey(values), objectId);
      }
    }
  }

  return {
    definitions,
    composite: bucketsToRecord(composite),
    range: rangeToRecord(range),
    text: bucketsToRecord(text),
    fullText: bucketsToRecord(fullText),
    expression: bucketsToRecord(expression),
    unique: uniqueToRecord(unique),
    statistics: statisticsFor({ composite, range, text, fullText, expression, unique }),
  };
}

export function advancedIndexFromRecord(record: StorageAdvancedIndexRecord | undefined): GvqlAdvancedGraphIndex | undefined {
  if (!record) return undefined;
  return {
    definitions: record.definitions,
    composite: bucketsFromRecord(record.composite),
    range: new Map(Object.entries(record.range).map(([key, entries]) => [key, entries.map((entry) => ({ ...entry, objectIds: [...entry.objectIds] }))])),
    text: bucketsFromRecord(record.text),
    fullText: bucketsFromRecord(record.fullText),
    expression: bucketsFromRecord(record.expression),
    unique: new Map(Object.entries(record.unique).map(([key, value]) => [key, new Map(Object.entries(value))])),
    statistics: record.statistics,
  };
}

export function advancedDefinitions(options: AdvancedIndexOptions): StorageAdvancedIndexDefinitionRecord[] {
  return [
    ...options.composites.map((item) => ({ ...item, kind: "composite" as const, name: item.name ?? indexName("composite", item.type, item.paths) })),
    ...options.ranges.map((item) => ({ ...item, kind: "range" as const, name: item.name ?? indexName("range", item.type, [item.path]) })),
    ...options.text.map((item) => ({ minGram: 2, maxGram: 4, ...item, kind: "text" as const, name: item.name ?? indexName("text", item.type, [item.path]) })),
    ...options.fullText.map((item) => ({ ...item, kind: "fullText" as const, name: item.name ?? indexName("fullText", item.type, [item.path]) })),
    ...options.unique.map((item) => ({ ...item, kind: "unique" as const, paths: item.paths ?? (item.path ? [item.path] : []), name: item.name ?? indexName("unique", item.type, item.paths ?? (item.path ? [item.path] : [])) })),
    ...options.expressions.map((item) => ({ ...item, kind: "expression" as const, name: item.name ?? indexName("expression", item.type, [`${item.expression.fn}(${item.expression.path})`]) })),
  ].filter((item) => hasValidTarget(item));
}

function valuesForDefinition(node: EncodedNode, definition: StorageAdvancedIndexDefinitionRecord): unknown[] {
  if (definition.kind === "expression" && definition.expression) return [evaluateExpression(node, definition.expression)];
  return (definition.paths ?? (definition.path ? [definition.path] : [])).map((path) => encodedValueToJs(getNodePath(node, path)));
}

function evaluateExpression(node: EncodedNode, expression: NonNullable<StorageAdvancedIndexDefinitionRecord["expression"]>): unknown {
  const value = encodedValueToJs(getNodePath(node, expression.path));
  if (value === null || typeof value === "undefined") return value;
  if (expression.fn === "length") return typeof value === "string" || Array.isArray(value) ? value.length : String(value).length;
  const text = String(value);
  if (expression.fn === "lower") return text.toLocaleLowerCase();
  if (expression.fn === "upper") return text.toLocaleUpperCase();
  return text.trim();
}

function matchesCondition(node: EncodedNode, condition: StorageIndexCondition): boolean {
  const left = encodedValueToJs(getNodePath(node, condition.path));
  const operator = condition.operator ?? "=";
  if (operator === "IS NULL") return isMissing(left);
  if (operator === "IS NOT NULL") return !isMissing(left);
  if (operator === "IN") return (condition.values ?? []).includes(left);
  if (operator === "!=") return left !== condition.value;
  return left === condition.value;
}

function definitionMatches(definition: StorageAdvancedIndexDefinitionRecord, node: EncodedNode): boolean {
  return !definition.type || (node.kind === "object" && node.type === definition.type);
}

function hasValidTarget(definition: StorageAdvancedIndexDefinitionRecord): boolean {
  if (definition.kind === "expression") return Boolean(definition.expression?.path);
  return Boolean(definition.path || definition.paths?.length);
}

function addBucket(target: Map<string, Map<string, string[]>>, name: string, key: string, objectId: string): void {
  const buckets = target.get(name) ?? new Map<string, string[]>();
  const bucket = buckets.get(key) ?? [];
  bucket.push(objectId);
  buckets.set(key, bucket);
  target.set(name, buckets);
}

function addTerms(target: Map<string, Map<string, string[]>>, name: string, terms: string[], objectId: string): void {
  for (const term of terms) addBucket(target, name, term, objectId);
}

function addRange(target: Map<string, Map<string, { raw: unknown; objectIds: string[] }>>, name: string, value: unknown, objectId: string): void {
  if (isMissing(value)) return;
  const buckets = target.get(name) ?? new Map<string, { raw: unknown; objectIds: string[] }>();
  const key = stableIndexValueKey(value);
  const bucket = buckets.get(key) ?? { raw: value, objectIds: [] };
  bucket.objectIds.push(objectId);
  buckets.set(key, bucket);
  target.set(name, buckets);
}

function addUnique(target: Map<string, Map<string, string>>, name: string, key: string, objectId: string): void {
  const entries = target.get(name) ?? new Map<string, string>();
  const existing = entries.get(key);
  if (existing && existing !== objectId) throw new Error(`Unique GraphVault index "${name}" rejects duplicate value ${key}.`);
  entries.set(key, objectId);
  target.set(name, entries);
}

function bucketsToRecord(map: Map<string, Map<string, string[]>>): Record<string, Record<string, string[]>> {
  return Object.fromEntries([...map.entries()].sort().map(([name, buckets]) => [name, Object.fromEntries([...buckets.entries()].sort().map(([key, ids]) => [key, [...ids].sort()]))]));
}

function bucketsFromRecord(record: Record<string, Record<string, string[]>>): Map<string, Map<string, string[]>> {
  return new Map(Object.entries(record).map(([name, buckets]) => [name, new Map(Object.entries(buckets).map(([key, ids]) => [key, [...ids]]))]));
}

function rangeToRecord(map: Map<string, Map<string, { raw: unknown; objectIds: string[] }>>): StorageAdvancedIndexRecord["range"] {
  return Object.fromEntries([...map.entries()].sort().map(([name, buckets]) => [name, [...buckets.entries()].map(([value, entry]) => ({ value, raw: entry.raw, objectIds: [...entry.objectIds].sort() })).sort((a, b) => compare(a.raw, b.raw))]));
}

function uniqueToRecord(map: Map<string, Map<string, string>>): Record<string, Record<string, string>> {
  return Object.fromEntries([...map.entries()].sort().map(([name, entries]) => [name, Object.fromEntries([...entries.entries()].sort())]));
}

function statisticsFor(input: Record<string, Map<string, Map<string, string[]>> | Map<string, Map<string, { objectIds: string[] }>> | Map<string, Map<string, string>>>): StorageAdvancedIndexRecord["statistics"] {
  const result: StorageAdvancedIndexRecord["statistics"] = {};
  for (const [family, indexes] of Object.entries(input)) {
    for (const [name, buckets] of indexes) {
      const values = [...buckets.values()].map((bucket) => Array.isArray(bucket) ? bucket : typeof bucket === "string" ? [bucket] : bucket.objectIds);
      result[`${family}:${name}`] = indexStatistics(values);
    }
  }
  return result;
}

function indexName(kind: string, type: string | undefined, paths: readonly string[]): string {
  return [kind, type ?? "*", paths.join("+")].join(":");
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function isMissing(value: unknown): boolean {
  return value === null || typeof value === "undefined";
}
