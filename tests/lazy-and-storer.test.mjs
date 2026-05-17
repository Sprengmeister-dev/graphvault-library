import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LazyArrayList } from "../dist/lazy/lazy-array-list.js";
import { lazy, LazyRef } from "../dist/lazy/lazy-ref.js";
import { startStorage, Storer } from "../dist/index.js";
import { bindStorageLazyRefs, storeLoadedStorageLazyRefs } from "../dist/storage/storage-lazy-helpers.js";

const saved = [];
const loadedRef = LazyRef.unloaded("item-1");
loadedRef.bind(async (key) => ({ key, value: 7 }), async (key, value) => saved.push({ key, value }));
assert.equal(loadedRef.isLoaded(), false);
assert.deepEqual(await loadedRef.get(), { key: "item-1", value: 7 });
assert.equal(loadedRef.isLoaded(), true);
loadedRef.set({ key: "item-1", value: 8 });
await loadedRef.store();
assert.deepEqual(saved, [{ key: "item-1", value: { key: "item-1", value: 8 } }]);
loadedRef.clear();
assert.equal(loadedRef.isLoaded(), false);

await assert.rejects(() => LazyRef.unloaded("missing-loader").get(), /no loader bound/);
await assert.doesNotReject(() => LazyRef.unloaded("not-loaded").store());
await assert.rejects(() => lazy("missing-saver", 1).store(), /no saver bound/);
assert.equal(await lazy("eager", 42).get(), 42);

const helperSaved = [];
const nestedLazy = LazyRef.unloaded("nested");
const loadedLazy = lazy("loaded", { done: true });
const cyclicObject = { nestedLazy };
cyclicObject.self = cyclicObject;
const lazyGraph = {
  map: new Map([[nestedLazy, new Set([loadedLazy, cyclicObject])]]),
};
bindStorageLazyRefs(lazyGraph, {
  load: async (key) => ({ key, loaded: true }),
  store: async (key, value) => helperSaved.push({ key, value }),
});
assert.deepEqual(await nestedLazy.get(), { key: "nested", loaded: true });
await storeLoadedStorageLazyRefs(lazyGraph);
assert.equal(helperSaved.some((entry) => entry.key === "nested"), true);
assert.equal(helperSaved.some((entry) => entry.key === "loaded"), true);

assert.throws(() => new LazyArrayList(0), /segmentSize/);
const list = new LazyArrayList(2);
assert.equal(await list.push("a"), 1);
assert.equal(await list.push("b"), 2);
assert.equal(await list.push("c"), 3);
assert.equal(list.size, 3);
assert.equal(await list.get(0), "a");
assert.equal(await list.get(2), "c");
await list.set(1, "B");
assert.deepEqual(await list.toArray(), ["a", "B", "c"]);
await assert.rejects(() => list.get(3), /outside the list bounds/);
await assert.rejects(() => list.storeSegments(), /no saver bound/);
list.clearLoadedSegments();
await assert.rejects(() => list.get(0), /no loader bound/);
await assert.doesNotReject(() => list.storeSegments());

const committedTargets = [];
const manager = {
  async commitStorer(mode, targets) {
    committedTargets.push({ mode, targets: [...targets] });
    return {
      transactionId: 1,
      storedAt: new Date("2026-01-01T00:00:00.000Z"),
      snapshotFile: "snapshot.json",
      journalFile: "journal.json",
      mode,
      objectCount: targets.length,
      objectIds: targets.map((_, index) => String(index + 1)),
    };
  },
};
const storer = new Storer(manager, "eager");
const metadata = await storer.store("first").storeAll(["second", "third"]).commit();
assert.equal(metadata.objectCount, 3);
assert.deepEqual(committedTargets, [{ mode: "eager", targets: ["first", "second", "third"] }]);
assert.throws(() => storer.store("after-commit"), /already been committed/);
await assert.rejects(() => storer.commit(), /already been committed/);

const directory = await mkdtemp(join(tmpdir(), "graphvault-start-storage-"));
try {
  const storage = await startStorage({
    storageDirectory: directory,
    rootFactory: () => ({ docs: [{ id: "doc-1" }] }),
    writeProfile: "production",
  });
  assert.equal(storage.root.docs[0].id, "doc-1");
  await storage.shutdown();
} finally {
  await rm(directory, { recursive: true, force: true });
}
