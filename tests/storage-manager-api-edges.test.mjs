import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EmbeddedStorage,
  MemoryStorageTarget,
  StorageManager,
  StorageNotStartedError,
  TransactionScopeError,
} from "../dist/index.js";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "graphvault-manager-edges-"));

try {
  const unstarted = new StorageManager({
    storageDirectory: join(temporaryDirectory, "unstarted"),
    rootFactory: () => ({ value: 1 }),
  });
  assert.throws(() => unstarted.root, StorageNotStartedError);
  await assert.rejects(() => unstarted.storeRoot(), StorageNotStartedError);

  const customRoot = { items: [], meta: { name: "custom" } };
  const manager = new StorageManager({
    storageDirectory: join(temporaryDirectory, "main"),
    channelCount: 2,
    customRoot,
    indexes: { mode: "persistent", consistency: "strict" },
    housekeepingIntervalMs: 60_000,
    rootFactory: () => ({ items: [], meta: { name: "factory" } }),
  });

  await manager.start();
  await manager.start();
  assert.deepEqual(manager.root, { items: [], meta: { name: "factory" } });
  assert.equal(manager.getRoot(), manager.root);
  assert.equal(manager.defaultRoot(), manager.root);
  assert.equal(manager.customRoot(), customRoot);
  assert.equal(manager.status().housekeepingActive, true);
  assert.equal(manager.status().channelCount, 2);

  manager.setRoot({ items: [{ id: "manual", value: 1 }], meta: { name: "manual" } });
  assert.deepEqual(manager.root.items, [{ id: "manual", value: 1 }]);
  await manager.storeRoot();

  const storer = manager.createStorer();
  manager.root.items.push({ id: "standard", value: 2 });
  storer.store(manager.root.items.at(-1));
  await storer.commit();

  const eagerStorer = manager.createEagerStorer();
  manager.root.items.push({ id: "eager", value: 3 });
  eagerStorer.store(manager.root);
  await eagerStorer.commit();

  const lazyStorer = manager.createLazyStorer();
  manager.root.items.push({ id: "lazy-target", value: 4 });
  lazyStorer.store(manager.root.items.at(-1));
  await lazyStorer.commit();

  await manager.storeAll(manager.root.items[0], manager.root.items[1]);
  await manager.storeAll(manager.root.items);

  const lazyReference = await manager.createLazyRef("details/1", { body: "loaded later" });
  assert.equal(await lazyReference.get().then((value) => value.body), "loaded later");
  await manager.storeLazy("details/2", { body: "direct" });
  assert.deepEqual(await manager.loadLazy("details/2"), { body: "direct" });

  const rolledBackRoot = manager.cloneForTest?.();
  await assert.rejects(
    () => manager.update((root) => {
      root.meta.name = "should rollback";
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(manager.root.meta.name, rolledBackRoot?.meta?.name ?? "manual");

  await assert.rejects(
    () => manager.transaction(({ root }) => {
      root.meta.name = "blocked nested commit";
      return manager.storeRoot();
    }),
    TransactionScopeError,
  );
  assert.equal(manager.root.meta.name, "manual");

  const nonConsistentBackup = await manager.backup({
    storageDirectory: join(temporaryDirectory, "non-consistent-copy"),
    consistent: false,
  });
  assert.equal(nonConsistentBackup.consistent, false);
  assert.equal(nonConsistentBackup.filesCopied > 0, true);

  const aliasGarbage = await manager.issueGarbageCollection(1);
  assert.equal(typeof aliasGarbage.removedObjects, "number");
  const aliasFullGarbage = await manager.issueFullGarbageCollection();
  assert.equal(typeof aliasFullGarbage.keptObjects, "number");
  const aliasCheck = await manager.issueFileCheck(1);
  assert.equal(aliasCheck.ok, true);
  const aliasFullCheck = await manager.issueFullFileCheck();
  assert.equal(aliasFullCheck.ok, true);
  const aliasMaintenance = await manager.issueFullMaintenance({ verify: false });
  assert.equal("verification" in aliasMaintenance, false);

  const indexBefore = await manager.indexStatus();
  assert.equal(indexBefore.enabled, true);
  const indexVerification = await manager.verifyIndexes();
  assert.equal(typeof indexVerification.ok, "boolean");
  const repairedIndex = await manager.repairIndexes();
  assert.equal(repairedIndex.enabled, true);

  const queryViaIndex = await manager.gvql('MATCH (item) WHERE item.id = "eager" RETURN item.value AS value');
  assert.deepEqual(queryViaIndex.rows, [{ value: 3 }]);

  await manager.onApplicationShutdown();
  assert.equal(manager.status().started, false);
  await manager.shutdown();

  const snapshotOnly = await EmbeddedStorage.start({
    storageDirectory: join(temporaryDirectory, "snapshot-only"),
    rootFactory: () => ({ children: [{ name: "fallback" }] }),
    transactionLog: "off",
  });
  await snapshotOnly.storeRoot();
  const snapshotSubtree = await snapshotOnly.loadSubtree({ depth: 0 });
  assert.equal(snapshotSubtree.transactionId, 1);
  await snapshotOnly.shutdown();

  const emptyCompaction = await new StorageManager({
    storageDirectory: "memory-empty",
    storageTarget: new MemoryStorageTarget(),
    rootFactory: () => ({ items: [] }),
  }).start();
  assert.deepEqual(await emptyCompaction.compact(), { kept: 0, removed: 0 });
  await emptyCompaction.shutdown();
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
