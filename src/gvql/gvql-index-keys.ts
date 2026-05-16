import type { StorageIndexStatistics } from "../core/types.js";

export function stableIndexValueKey(value: unknown): string {
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (value && typeof value === "object") return `json:${stableStringify(value)}`;
  return `${typeof value}:${String(value)}`;
}

export function tupleIndexKey(values: readonly unknown[]): string {
  return values.map(stableIndexValueKey).join("\u0001");
}

export function normalizeIndexText(value: unknown, caseSensitive = false): string {
  const text = String(value ?? "").normalize("NFKC");
  return caseSensitive ? text : text.toLocaleLowerCase();
}

export function tokenizeIndexText(value: unknown, caseSensitive = false): string[] {
  const normalized = normalizeIndexText(value, caseSensitive);
  return Array.from(new Set(normalized.match(/[\p{L}\p{N}_]+/gu) ?? []));
}

export function textIndexTerms(value: unknown, options: { caseSensitive?: boolean; minGram?: number; maxGram?: number }): string[] {
  const text = normalizeIndexText(value, options.caseSensitive);
  if (!text) return [];
  const minGram = Math.max(1, options.minGram ?? 2);
  const maxGram = Math.max(minGram, options.maxGram ?? 4);
  const terms = new Set<string>();
  const maxPrefix = Math.min(text.length, 64);
  for (let length = 1; length <= maxPrefix; length++) {
    terms.add(`prefix:${text.slice(0, length)}`);
    terms.add(`suffix:${text.slice(text.length - length)}`);
  }
  for (let size = minGram; size <= Math.min(maxGram, text.length); size++) {
    for (let index = 0; index <= text.length - size; index++) {
      terms.add(`gram:${text.slice(index, index + size)}`);
    }
  }
  for (const token of tokenizeIndexText(text, true)) {
    terms.add(`token:${token}`);
  }
  return Array.from(terms);
}

export function textLookupTerms(operator: "CONTAINS" | "STARTS WITH" | "ENDS WITH", value: unknown, options: { caseSensitive?: boolean; minGram?: number; maxGram?: number }): string[] {
  const text = normalizeIndexText(value, options.caseSensitive);
  if (!text) return [];
  if (operator === "STARTS WITH") return [`prefix:${text}`];
  if (operator === "ENDS WITH") return [`suffix:${text}`];
  const minGram = Math.max(1, options.minGram ?? 2);
  const maxGram = Math.max(minGram, options.maxGram ?? 4);
  if (text.length < minGram) return [];
  const size = Math.min(maxGram, text.length);
  const terms: string[] = [];
  for (let index = 0; index <= text.length - size; index++) {
    terms.push(`gram:${text.slice(index, index + size)}`);
  }
  return terms;
}

export function indexStatistics(buckets: Iterable<readonly unknown[]>): StorageIndexStatistics {
  let keys = 0;
  let entries = 0;
  let maxBucketSize = 0;
  for (const bucket of buckets) {
    keys++;
    entries += bucket.length;
    maxBucketSize = Math.max(maxBucketSize, bucket.length);
  }
  return {
    entries,
    keys,
    maxBucketSize,
    averageBucketSize: keys ? entries / keys : 0,
    selectivity: entries ? keys / entries : 0,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}
