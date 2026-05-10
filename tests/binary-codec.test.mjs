import assert from "node:assert/strict";
import { decodeBinaryRecord, encodeBinaryRecord } from "../dist/binary-codec.js";

const encoded = encodeBinaryRecord({ kind: "object", value: [1, 2, 3] });
const decoded = decodeBinaryRecord(encoded);
assert.deepEqual(decoded, { kind: "object", value: [1, 2, 3] });

const utf8 = encodeBinaryRecord("hello");
const text = decodeBinaryRecord(utf8);
assert.equal(text, "hello");

const invalid = Buffer.from("plain-text");
assert.throws(() => decodeBinaryRecord(invalid), /Invalid GraphVault binary object record/);
