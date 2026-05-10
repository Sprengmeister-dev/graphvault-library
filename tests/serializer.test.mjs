import assert from "node:assert/strict";
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
