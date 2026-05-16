import assert from "node:assert/strict";
import {
  encodedValueToJs,
  getNodePath,
  jsValueToEncoded,
  literalToJs,
  removeNodePath,
  setNodePath,
} from "../dist/gvql/gvql-values.js";

const specialNumber = { $type: "number", value: "NaN" };
assert.equal(Number.isNaN(encodedValueToJs(specialNumber)), true);
assert.equal(encodedValueToJs({ $type: "number", value: "Infinity" }), Infinity);
assert.equal(encodedValueToJs({ $type: "number", value: "-Infinity" }), -Infinity);
assert.equal(encodedValueToJs({ $type: "number", value: "-0" }), -0);
assert.equal(encodedValueToJs({ $type: "undefined" }), undefined);
assert.equal(encodedValueToJs({ $type: "bigint", value: "9007199254740991" }), 9007199254740991n);
assert.equal(encodedValueToJs({ $type: "date", value: "2026-01-01T00:00:00.000Z" }), "2026-01-01T00:00:00.000Z");
assert.equal(encodedValueToJs({ $type: "buffer", value: Buffer.from("aGVsbG8=").toString("base64") }), Buffer.from("aGVsbG8=").toString("base64"));
assert.equal(encodedValueToJs({ $type: "arraybuffer", value: "AQI=" }), "AQI=");
assert.equal(encodedValueToJs({ $type: "sharedarraybuffer", value: "AQI=" }), "AQI=");
assert.equal(encodedValueToJs({ $type: "dataview", value: "AQI=" }), "AQI=");
assert.equal(encodedValueToJs({ $type: "typedarray", value: "AQI=" }), "AQI=");
assert.equal(encodedValueToJs({ $type: "regexp", source: "test", flags: "gi" }), "/test/gi");
assert.equal(encodedValueToJs({ $type: "url", value: "https://example.com/" }), "https://example.com/");
assert.equal(encodedValueToJs({ $type: "urlsearchparams", value: "q=x" }), "q=x");
assert.equal(encodedValueToJs({ $type: "symbol", key: "x" }), "Symbol(x)");
assert.equal(encodedValueToJs({ $type: "symbol", global: true, key: "global" }), "Symbol(global)");
assert.equal(encodedValueToJs({ $type: "symbol", key: null }), "Symbol()");
assert.equal(encodedValueToJs({ $type: "error", message: "boom" }), "boom");
assert.equal(encodedValueToJs(undefined), undefined);

assert.deepEqual(encodedValueToJs({ $ref: "a" }), { $ref: "a" });

assert.deepEqual(
  jsValueToEncoded("hello"),
  "hello",
);
assert.deepEqual(jsValueToEncoded(7), 7);
assert.deepEqual(jsValueToEncoded(true), true);
assert.deepEqual(jsValueToEncoded(null), null);
assert.deepEqual(jsValueToEncoded(undefined), { $type: "undefined" });
assert.deepEqual(jsValueToEncoded(7n), { $type: "bigint", value: "7" });
assert.deepEqual(jsValueToEncoded(new Date("2026-01-01T00:00:00.000Z")), { $type: "date", value: "2026-01-01T00:00:00.000Z" });
assert.throws(() => jsValueToEncoded({ unsupported: true }), /GVQL SET currently supports/);

const arrayNode = { kind: "array", items: [1, 2] };
assert.equal(getNodePath(arrayNode, "[0]"), 1);
assert.equal(getNodePath(arrayNode, "[1]"), 2);
assert.equal(getNodePath(arrayNode, "[9]"), undefined);
assert.deepEqual(getNodePath(arrayNode), [1, 2]);

const objectNode = { kind: "object", props: { id: "x", status: "draft" } };
assert.equal(getNodePath(objectNode, "status"), "draft");
const changedObject = structuredClone(objectNode);
changedObject.props = { ...objectNode.props };
setNodePath(changedObject, "status", "archived");
assert.equal(changedObject.props.status, "archived");

const removed = removeNodePath(changedObject, "status");
assert.equal(removed.before, "archived");
assert.equal(removed.removed, true);
function removedNodeSafe() {
  try {
    removeNodePath({ kind: "array", items: [] }, "0");
  } catch (error) {
    return error.message;
  }
  return false;
}
assert.match(removedNodeSafe(), /currently supports object fields/);

const mapNode = {
  kind: "map",
  entries: [
    [{ $type: "number", value: "1" }, { $type: "number", value: "2" }],
    [{ $type: "number", value: "3" }, { $type: "number", value: "4" }],
  ],
};
assert.deepEqual(getNodePath(mapNode, "entries[1].key"), { $type: "number", value: "3" });
assert.deepEqual(getNodePath(mapNode, "entries[0].value"), { $type: "number", value: "2" });
assert.equal(getNodePath(mapNode, "entries[x].value"), undefined);
setNodePath(mapNode, "entries[1].value", { $type: "number", value: "8" });
assert.deepEqual(mapNode.entries[1][1], { $type: "number", value: "8" });
setNodePath(mapNode, "entries[0].key", { $type: "number", value: "10" });
assert.deepEqual(mapNode.entries[0][0], { $type: "number", value: "10" });
assert.throws(() => setNodePath(mapNode, "bad", 1), /Unsupported GVQL map path/);
assert.throws(() => setNodePath(mapNode, "entries[9].value", 1), /Unsupported GVQL map path/);
assert.throws(() => setNodePath({ kind: "lazy", key: "segment" }, "value", 1), /cannot set fields/);
assert.throws(() => setNodePath(arrayNode, "bad", 1), /Unsupported GVQL array path/);
assert.throws(() => setNodePath(objectNode, undefined, 1), /requires an aliased property path/);
assert.deepEqual(removeNodePath(changedObject, "missing"), { before: undefined, removed: false });
assert.throws(() => removeNodePath(changedObject, undefined), /requires an aliased property path/);
assert.deepEqual(getNodePath({ kind: "lazy", key: "segment" }), { kind: "lazy", key: "segment" });

const literal = {
  path: "$id",
  values: [
    "demo",
    { parameter: "count", value: 2 },
    { parameter: "enabled" },
  ],
};
const resolved = literalToJs(literal, { count: 2, enabled: true });
assert.deepEqual(resolved, {
  path: "$id",
  values: [
    "demo",
    { parameter: "count", value: 2 },
    { parameter: "enabled" },
  ],
});
