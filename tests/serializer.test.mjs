import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { GraphSerializer, TypeRegistry } from "../dist/core/serializer.js";
import { UnknownTypeError } from "../dist/core/errors.js";

class EventItem {
  constructor(id, seen = new Date("2026-01-01T00:00:00.000Z")) {
    this.id = id;
    this.seen = seen;
    this.count = 1;
  }
}

const serializer = new GraphSerializer(
  new TypeRegistry([{ name: "EventItem", ctor: EventItem, version: 2, serialize: (value) => ({ id: value.id, seen: value.seen }) }]),
);

const envelope = serializer.serialize({ id: "evt-1", seen: new Date("2026-01-01T00:00:00.000Z"), nested: new Map([["x", 1]]) });
const restored = serializer.deserialize(envelope);
assert.equal(restored.seen.toISOString(), "2026-01-01T00:00:00.000Z");
assert.equal(restored.nested instanceof Map, true);
assert.equal(restored.nested.get("x"), 1);

const cycle = { name: "loop" };
cycle.self = cycle;
const cycleEnvelope = serializer.serialize(cycle);
const restoredCycle = serializer.deserialize(cycleEnvelope);
assert.equal(restoredCycle === restoredCycle.self, true);

const event = new EventItem("user-1");
const eventEnvelope = serializer.serialize(event);
const eventData = serializer.deserialize(eventEnvelope);
assert.equal(eventData.id, "user-1");
assert.equal("count" in eventData, false);

let migrationRan = false;
class MigratedThing {
  constructor(value) {
    this.value = value;
  }
}

const migratingSerializer = new GraphSerializer([
  {
    name: "MigratedThing",
    ctor: MigratedThing,
    version: 2,
    migrate: (state) => {
      migrationRan = true;
      return { value: `${state.value}-migrated` };
    },
  },
]);
const migrated = migratingSerializer.serialize(new MigratedThing(7));
const legacyMigrationEnvelope = {
  ...migrated,
  nodes: Object.fromEntries(
    Object.entries(migrated.nodes).map(([id, node]) => [id, node.kind === "object" ? { ...node, version: 1 } : node]),
  ),
};
migratingSerializer.deserialize(legacyMigrationEnvelope);
assert.equal(migrationRan, true);

const unknownTypeEnvelope = {
  format: "graphvault",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  root: { $ref: "missing-type" },
  nodes: {
    "missing-type": {
      kind: "object",
      type: "MissingType",
      version: 1,
      props: {},
    },
  },
};
assert.throws(() => serializer.deserialize(unknownTypeEnvelope), UnknownTypeError);

const symbolKey = Symbol("local-key");
const globalSymbolKey = Symbol.for("graphvault.test.symbol");
const arrayBuffer = new Uint8Array([1, 2, 3]).buffer;
const sharedBuffer = new SharedArrayBuffer(2);
new Uint8Array(sharedBuffer).set([4, 5]);
const specialValues = {
  nan: Number.NaN,
  positiveInfinity: Infinity,
  negativeInfinity: -Infinity,
  negativeZero: -0,
  missing: undefined,
  bigint: 99n,
  localSymbol: Symbol("local-value"),
  globalSymbol: Symbol.for("global-value"),
  url: new URL("https://example.com/a?b=1"),
  params: new URLSearchParams("q=graphvault&sort=desc"),
  regexp: /graphvault/gi,
  buffer: Buffer.from("stored"),
  arrayBuffer,
  sharedBuffer,
  view: new DataView(new Uint8Array([9, 8, 7]).buffer, 1, 2),
  int8: new Int8Array([-1, 2]),
  uint8: new Uint8Array([1, 2]),
  uint8Clamped: new Uint8ClampedArray([1, 255]),
  int16: new Int16Array([-2, 3]),
  uint16: new Uint16Array([2, 3]),
  int32: new Int32Array([-4, 5]),
  uint32: new Uint32Array([4, 5]),
  float32: new Float32Array([1.5, 2.5]),
  float64: new Float64Array([1.25, 2.75]),
  bigInt64: new BigInt64Array([-1n, 2n]),
  bigUint64: new BigUint64Array([1n, 2n]),
  error: new TypeError("typed failure", { cause: new Error("root cause") }),
  aggregate: new AggregateError([new RangeError("range")], "aggregate failure"),
  [symbolKey]: "symbol-value",
  [globalSymbolKey]: "global-symbol-value",
};
const specialRoundtrip = serializer.deserialize(serializer.serialize(specialValues));
assert.equal(Number.isNaN(specialRoundtrip.nan), true);
assert.equal(specialRoundtrip.positiveInfinity, Infinity);
assert.equal(specialRoundtrip.negativeInfinity, -Infinity);
assert.equal(Object.is(specialRoundtrip.negativeZero, -0), true);
assert.equal(specialRoundtrip.missing, undefined);
assert.equal(specialRoundtrip.bigint, 99n);
assert.equal(typeof specialRoundtrip.localSymbol, "symbol");
assert.equal(Symbol.keyFor(specialRoundtrip.globalSymbol), "global-value");
assert.equal(specialRoundtrip.url.href, "https://example.com/a?b=1");
assert.equal(specialRoundtrip.params.get("sort"), "desc");
assert.equal(specialRoundtrip.regexp.flags, "gi");
assert.equal(specialRoundtrip.buffer.toString(), "stored");
assert.deepEqual([...new Uint8Array(specialRoundtrip.arrayBuffer)], [1, 2, 3]);
assert.deepEqual([...new Uint8Array(specialRoundtrip.sharedBuffer)], [4, 5]);
assert.deepEqual([...new Uint8Array(specialRoundtrip.view.buffer)], [8, 7]);
assert.deepEqual([...specialRoundtrip.int8], [-1, 2]);
assert.deepEqual([...specialRoundtrip.uint8], [1, 2]);
assert.deepEqual([...specialRoundtrip.uint8Clamped], [1, 255]);
assert.deepEqual([...specialRoundtrip.int16], [-2, 3]);
assert.deepEqual([...specialRoundtrip.uint16], [2, 3]);
assert.deepEqual([...specialRoundtrip.int32], [-4, 5]);
assert.deepEqual([...specialRoundtrip.uint32], [4, 5]);
assert.deepEqual([...specialRoundtrip.float32], [1.5, 2.5]);
assert.deepEqual([...specialRoundtrip.float64], [1.25, 2.75]);
assert.deepEqual([...specialRoundtrip.bigInt64], [-1n, 2n]);
assert.deepEqual([...specialRoundtrip.bigUint64], [1n, 2n]);
assert.equal(specialRoundtrip.error instanceof TypeError, true);
assert.equal(specialRoundtrip.error.cause.message, "root cause");
assert.equal(specialRoundtrip.aggregate instanceof AggregateError, true);
assert.equal(specialRoundtrip.aggregate.errors[0] instanceof RangeError, true);
assert.equal(specialRoundtrip[symbolKey], undefined);
assert.equal(Object.values(Object.getOwnPropertyDescriptors(specialRoundtrip)).some((entry) => entry.value === "symbol-value"), false);
assert.equal(specialRoundtrip[globalSymbolKey], "global-symbol-value");

class HydratedThing {}
const hydratedSerializer = new GraphSerializer([
  {
    name: "HydratedThing",
    ctor: HydratedThing,
    create: () => new HydratedThing(),
    hydrate: (target, state, fromVersion) => {
      target.value = `${state.value}:${fromVersion}`;
    },
  },
]);
const hydratedEnvelope = hydratedSerializer.serialize(new HydratedThing());
const hydratedId = Object.keys(hydratedEnvelope.nodes)[0];
hydratedEnvelope.nodes[hydratedId].props.value = "custom";
const hydratedThing = hydratedSerializer.deserialize(hydratedEnvelope);
assert.equal(hydratedThing.value, "custom:1");

const invalidSymbolEnvelope = {
  format: "graphvault",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  root: { $ref: "1" },
  nodes: {
    1: { kind: "object", props: {}, symbolProps: [["not-a-symbol", "value"]] },
  },
};
assert.throws(() => serializer.deserialize(invalidSymbolEnvelope), /symbol property key/);
assert.throws(() => serializer.serialize(() => undefined), /Cannot serialize value of type function/);
