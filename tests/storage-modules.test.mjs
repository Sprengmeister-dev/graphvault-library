import assert from "node:assert/strict";
import { join } from "node:path";
import { GraphSerializer } from "../dist/core/serializer.js";
import { LazyRef } from "../dist/lazy/lazy-ref.js";
import { collectStorageGarbage } from "../dist/storage/storage-garbage.js";
import { migrationContext, migrationMetadata, migrationPlan, sortedSchemaMigrations, targetSchemaVersion } from "../dist/storage/storage-migrations.js";
import { collectObjectIdsForTargets } from "../dist/storage/storage-object-collector.js";
import { isIterable, replaceObjectContents } from "../dist/storage/storage-root-helpers.js";

assert.equal(isIterable(["a"]), true);
assert.equal(isIterable("abc"), true);
assert.equal(isIterable({}), false);
assert.equal(isIterable(null), false);

const arrayTarget = [1, 2, 3];
replaceObjectContents(arrayTarget, ["a", "b"]);
assert.deepEqual(arrayTarget, ["a", "b"]);

const mapTarget = new Map([["old", 1]]);
replaceObjectContents(mapTarget, new Map([["new", 2]]));
assert.deepEqual([...mapTarget], [["new", 2]]);

const setTarget = new Set(["old"]);
replaceObjectContents(setTarget, new Set(["new"]));
assert.deepEqual([...setTarget], ["new"]);

const objectTarget = { old: true, keep: false };
replaceObjectContents(objectTarget, { keep: true, fresh: 1 });
assert.deepEqual(objectTarget, { keep: true, fresh: 1 });

const migrations = [
  {
    version: 2,
    name: "second",
    up: ({ root }) => {
      root.steps.push("up-2");
    },
    down: ({ root }) => {
      root.steps.push("down-2");
    },
  },
  {
    version: 1,
    name: "first",
    up: ({ root }) => {
      root.steps.push("up-1");
    },
    down: ({ root }) => {
      root.steps.push("down-1");
    },
  },
];
assert.deepEqual(sortedSchemaMigrations(migrations).map((migration) => migration.version), [1, 2]);
assert.equal(targetSchemaVersion(undefined, migrations), 2);
assert.equal(targetSchemaVersion(1, migrations), 1);
assert.throws(() => targetSchemaVersion(-1, migrations), /schemaVersion/);
assert.throws(() => sortedSchemaMigrations([{ version: 1, up() {}, down() {} }, { version: 1, up() {}, down() {} }]), /Duplicate/);
assert.throws(() => sortedSchemaMigrations([{ version: 0, up() {}, down() {} }]), /positive safe integers/);

const upPlan = migrationPlan(0, 2, migrations);
assert.deepEqual(upPlan.map((step) => [step.direction, step.fromVersion, step.toVersion, step.version]), [
  ["up", 0, 1, 1],
  ["up", 1, 2, 2],
]);
assert.deepEqual(migrationMetadata(upPlan[0]), {
  version: 1,
  name: "first",
  direction: "up",
  fromVersion: 0,
  toVersion: 1,
});
assert.deepEqual(migrationContext({ steps: [] }, upPlan[0]), {
  root: { steps: [] },
  direction: "up",
  fromVersion: 0,
  toVersion: 1,
  version: 1,
  name: "first",
});
assert.deepEqual(migrationPlan(2, 0, migrations).map((step) => [step.direction, step.fromVersion, step.toVersion, step.version]), [
  ["down", 2, 1, 2],
  ["down", 1, 0, 1],
]);
assert.deepEqual(migrationPlan(1, 1, migrations), []);
assert.throws(() => migrationPlan(0, 2, [migrations[0]]), /Missing schema migration for version 1/);
assert.throws(() => migrationPlan(2, 0, [migrations[1]]), /Missing schema migration for version 2/);

const serializer = new GraphSerializer();
const root = {
  child: { name: "child", grandchild: { name: "grandchild" } },
  lazy: LazyRef.unloaded("large-segment"),
  entries: new Map([["key", { name: "mapped" }]]),
};
const envelope = serializer.serialize(root);
const rootId = serializer.objectIds.idFor(root);
const childId = serializer.objectIds.idFor(root.child);
const grandchildId = serializer.objectIds.idFor(root.child.grandchild);
const lazyId = serializer.objectIds.idFor(root.lazy);
const mapId = serializer.objectIds.idFor(root.entries);
const entryId = serializer.objectIds.idFor([...root.entries.values()][0]);

assert.deepEqual(
  collectObjectIdsForTargets({
    envelope,
    targets: [root.child],
    serializer,
    persistedObjectIds: new Set([grandchildId]),
  }),
  [childId],
);
assert.deepEqual(
  collectObjectIdsForTargets({
    envelope,
    targets: [root],
    serializer,
    persistedObjectIds: new Set([rootId, childId, grandchildId, lazyId, mapId, entryId]),
    eagerFieldEvaluator: ({ fieldName }) => fieldName === "child",
  }),
  [rootId, childId],
);
assert.deepEqual(
  collectObjectIdsForTargets({
    envelope,
    targets: [],
    serializer,
    persistedObjectIds: new Set(),
  }),
  [rootId],
);

const removed = [];
const garbage = await collectStorageGarbage({
  target: {
    async remove(path) {
      removed.push(path);
    },
  },
  layout: {
    objectRecordDirectories(kind) {
      return kind === "json" ? ["objects"] : ["objects-bin"];
    },
    lazyDirectory: "lazy",
  },
  reader: {
    async readManifest() {
      return {
        format: "graphvault-manifest",
        transactionId: 5,
        objectIds: ["1"],
        objectVersions: { 1: 3 },
      };
    },
    async envelopeFromManifest() {
      return {
        root: { $ref: "1" },
        nodes: {
          1: { kind: "object", type: "Object", fields: {} },
          2: { kind: "lazy", key: "seg/a" },
        },
      };
    },
    async readDirectoryIfExists(directory) {
      return {
        objects: ["1.json", "1.3.json", "stale.json", "note.txt"],
        "objects-bin": ["1.bin", "1.3.bin", "stale.bin"],
        lazy: ["seg%2Fa.json", "stale.json", "note.txt"],
      }[directory];
    },
  },
});
assert.deepEqual(garbage, {
  keptObjects: 2,
  removedObjects: 1,
  keptBinaryObjects: 2,
  removedBinaryObjects: 1,
  keptLazyFiles: 1,
  removedLazyFiles: 1,
});
assert.deepEqual(removed.sort(), [join("lazy", "stale.json"), join("objects", "stale.json"), join("objects-bin", "stale.bin")].sort());

const emptyGarbage = await collectStorageGarbage({
  target: { async remove() {} },
  layout: {
    objectRecordDirectories() {
      return [];
    },
    lazyDirectory: "lazy",
  },
  reader: {
    async readManifest() {
      return undefined;
    },
  },
});
assert.deepEqual(emptyGarbage, {
  keptObjects: 0,
  removedObjects: 0,
  keptBinaryObjects: 0,
  removedBinaryObjects: 0,
  keptLazyFiles: 0,
  removedLazyFiles: 0,
});
