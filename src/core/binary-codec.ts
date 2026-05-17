import { deserialize, serialize } from "node:v8";

const MAGIC = Buffer.from("GVOBJ001\n", "ascii");

/** Encodes an ObjectRecord as the compact binary representation used by binary object storage. */
export function encodeBinaryRecord(value: unknown): Buffer {
  return Buffer.concat([MAGIC, serialize(value)]);
}

/** Decodes a binary object-record payload back into an ObjectRecord. */
export function decodeBinaryRecord<T>(buffer: Buffer): T {
  if (buffer.length >= MAGIC.length && buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    return deserialize(buffer.subarray(MAGIC.length)) as T;
  }
  throw new Error("Invalid GraphVault binary object record.");
}
