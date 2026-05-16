import { createHash } from "node:crypto";
import type { SerializedEnvelope, TransactionRecord } from "./types.js";

/** Runs the public envelopeHash helper. */
export function envelopeHash(envelope: SerializedEnvelope): string {
  return sha256Hex(canonicalJson(envelope));
}

/** Runs the public transactionRecordHash helper. */
export function transactionRecordHash(record: Omit<TransactionRecord, "transactionHash">): string {
  return sha256Hex(canonicalJson(record));
}

/** Runs the public transactionHashPayload helper. */
export function transactionHashPayload(record: TransactionRecord): Omit<TransactionRecord, "transactionHash"> {
  const { transactionHash: _transactionHash, ...payload } = record;
  return payload;
}

/** Runs the public canonicalJson helper. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]));
}
