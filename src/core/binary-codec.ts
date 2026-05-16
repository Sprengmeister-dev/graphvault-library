import { deserialize, serialize } from "node:v8";

const MAGIC = Buffer.from("GVOBJ001\n", "ascii");

/** Runs the public encodeBinaryRecord helper. */
export function encodeBinaryRecord(value: unknown): Buffer {
  return Buffer.concat([MAGIC, serialize(value)]);
}

/** Runs the public decodeBinaryRecord helper. */
export function decodeBinaryRecord<T>(buffer: Buffer): T {
  if (buffer.length >= MAGIC.length && buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    return deserialize(buffer.subarray(MAGIC.length)) as T;
  }
  throw new Error("Invalid GraphVault binary object record.");
}
