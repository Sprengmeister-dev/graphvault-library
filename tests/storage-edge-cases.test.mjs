import assert from "node:assert/strict";
import { chdir, cwd } from "node:process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PersistentCache } from "../dist/cache/persistent-cache.js";
import { CorruptStorageError } from "../dist/core/errors.js";
import { EmbeddedStorage } from "../dist/storage/embedded-storage.js";
import { StorageLayout } from "../dist/storage/storage-layout.js";
import { loadSubtreeFromEnvelope, loadSubtreeFromManifest } from "../dist/storage/storage-subtree.js";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-edges-"));
const previousCwd = cwd();

try {
  const layout = new StorageLayout(join(temporaryDirectory, "layout"), 4);
  assert.equal(layout.channelDirectories().length, 4);
  assert.match(layout.objectRecordPath("5", 9), /ch_1.*5\.9\.json$/);
  assert.match(layout.objectRecordPath("alpha", 9), /channels.*objects.*alpha\.9\.json$/);
  assert.match(layout.binaryObjectPath("alpha"), /objects-bin.*alpha\.bin$/);
  assert.deepEqual(layout.objectRecordDirectories("json").map((path) => path.endsWith("objects")), [true, true, true, true]);
  assert.deepEqual(layout.objectRecordDirectories("binary").map((path) => path.endsWith("objects-bin")), [true, true, true, true]);
  assert.equal(layout.parseTransactionId("snapshot-000000000123.json"), 123);
  assert.throws(() => layout.parseTransactionId("current.json"), CorruptStorageError);
  assert.throws(() => new StorageLayout(temporaryDirectory, 3), /positive power of two/);
  assert.throws(() => new StorageLayout(temporaryDirectory, 0), /positive power of two/);

  const primitiveEnvelope = envelope("root-value", {});
  const primitiveSubtree = loadSubtreeFromEnvelope(primitiveEnvelope, { depth: 0 }, 11);
  assert.equal(primitiveSubtree.complete, true);
  assert.deepEqual(primitiveSubtree.objectIds, []);

  const objectEnvelope = envelope({ $ref: "1" }, {
    1: {
      kind: "object",
      props: {
        child: { $ref: "2" },
        missing: { $ref: "404" },
        map: { $ref: "3" },
        set: { $ref: "4" },
      },
      symbolProps: [[Symbol.for("graphvault-edge"), { $ref: "5" }]],
    },
    2: { kind: "array", items: [{ $ref: "6" }] },
    3: { kind: "map", entries: [[{ $ref: "7" }, { $ref: "8" }]] },
    4: { kind: "set", items: [{ $ref: "9" }] },
    5: { kind: "object", props: {} },
    6: { kind: "object", props: {} },
    7: { kind: "object", props: {} },
    8: { kind: "object", props: {} },
    9: { kind: "object", props: {} },
  });
  const shallow = loadSubtreeFromEnvelope(objectEnvelope, { depth: 1 });
  assert.deepEqual(new Set(shallow.objectIds), new Set(["1", "2", "3", "4", "5"]));
  assert.equal(shallow.complete, false);
  assert.equal(shallow.truncatedReferences.some((ref) => ref.toObjectId === "404"), true);
  assert.equal(shallow.truncatedReferences.some((ref) => ref.path === "entries[0].key"), true);
  assert.throws(() => loadSubtreeFromEnvelope(objectEnvelope, { rootObjectId: "404" }), /not present/);
  assert.throws(() => loadSubtreeFromEnvelope(objectEnvelope, { depth: -1 }), /non-negative integer/);

  const manifestReads = [];
  const manifestSubtree = await loadSubtreeFromManifest(
    {
      async readObjectRecord(objectId, transactionId) {
        manifestReads.push([objectId, transactionId]);
        return { objectId, transactionId, node: objectEnvelope.nodes[objectId] };
      },
    },
    {
      format: "graphvault-manifest",
      transactionId: 12,
      createdAt: "2026-01-01T00:00:00.000Z",
      root: { $ref: "1" },
      objectIds: Object.keys(objectEnvelope.nodes),
      objectVersions: { 1: 10, 2: 11 },
    },
    { depth: 1 },
  );
  assert.equal(manifestSubtree.complete, false);
  assert.deepEqual(manifestReads.slice(0, 2), [["1", 10], ["2", 11]]);
  await assert.rejects(
    () => loadSubtreeFromManifest({ async readObjectRecord() { throw new Error("unused"); } }, {
      format: "graphvault-manifest",
      transactionId: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      root: { $ref: "missing" },
      objectIds: ["1"],
    }),
    /not present/,
  );

  const cache = await PersistentCache.start({ storageDirectory: join(temporaryDirectory, "cache") });
  await cache.set("alpha", 1);
  await cache.set("beta", 2);
  assert.equal(cache.manager.root.entries instanceof Map, true);
  assert.deepEqual([...cache.keys()], ["alpha", "beta"]);
  assert.deepEqual([...cache.values()], [1, 2]);
  assert.deepEqual([...cache.entries()], [["alpha", 1], ["beta", 2]]);
  await cache.shutdown();

  const objectRoot = { value: 1 };
  const objectStorage = await EmbeddedStorage.start(objectRoot, join(temporaryDirectory, "embedded-object"));
  assert.equal(objectStorage.root.value, 1);
  await objectStorage.shutdown();

  chdir(temporaryDirectory);
  const emptyStorage = await EmbeddedStorage.start();
  assert.deepEqual(emptyStorage.root, {});
  await emptyStorage.shutdown();
} finally {
  chdir(previousCwd);
  await rm(temporaryDirectory, { force: true, recursive: true });
}

function envelope(root, nodes) {
  return {
    format: "graphvault",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    root,
    nodes,
  };
}
