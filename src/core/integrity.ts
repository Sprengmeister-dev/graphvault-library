import { createHash } from "node:crypto";
import type { SerializedEnvelope, TransactionRecord } from "./types.js";

/** Computes the deterministic hash of a serialized envelope for integrity checks. */
export function envelopeHash(envelope: SerializedEnvelope): string {
  return sha256Hex(canonicalJson(envelope));
}

/** Computes the deterministic hash of a transaction record for integrity verification. */
export function transactionRecordHash(record: Omit<TransactionRecord, "transactionHash">): string {
  return sha256Hex(canonicalJson(record));
}

/** Builds the canonical payload that is hashed into the transaction hash chain. */
export function transactionHashPayload(record: TransactionRecord): Omit<TransactionRecord, "transactionHash"> {
  const { transactionHash: _transactionHash, ...payload } = record;
  return payload;
}

/** Serializes values with stable object-key ordering so hashes are deterministic across processes. */
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
