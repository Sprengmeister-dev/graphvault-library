import type { StorageIndexRecord, StorageIndexVerificationResult } from "../core/types.js";

/** Compares expected and persisted index records and reports missing or stale index data. */
export function verifyStorageIndexRecord(input: {
  expected: StorageIndexRecord | undefined;
  actual: StorageIndexRecord | undefined;
}): StorageIndexVerificationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!input.expected) {
    if (input.actual) warnings.push("Persistent index exists although indexes are disabled.");
    return { ok: errors.length === 0, checkedIndexes: 0, errors, warnings };
  }
  if (!input.actual) {
    errors.push("Persistent index is missing.");
    return { ok: false, checkedIndexes: 0, errors, warnings };
  }
  if (stableStringify(comparableIndex(input.actual)) !== stableStringify(comparableIndex(input.expected))) {
    errors.push("Persistent index does not match the current committed graph and index configuration.");
  }
  return {
    ok: errors.length === 0,
    checkedIndexes: 1 + (input.actual.advanced?.definitions.length ?? 0),
    errors,
    warnings,
  };
}

function comparableIndex(record: StorageIndexRecord): Omit<StorageIndexRecord, "createdAt"> {
  const rest = { ...record };
  delete (rest as Partial<StorageIndexRecord>).createdAt;
  return rest;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}
