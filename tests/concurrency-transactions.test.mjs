import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EmbeddedStorage,
  GraphVaultTransactional,
  LocalFilesystemTarget,
  MemoryStorageTarget,
  OptimisticLockError,
  TransactionScopeError,
} from "../dist/index.js";

const target = new MemoryStorageTarget();
const storageDirectory = "concurrency-test";

const writerA = await EmbeddedStorage.start({
  storageDirectory,
  storageTarget: target,
  lockStrategy: "optimistic",
  rootFactory: () => ({ counter: 0, events: [] }),
});
await writerA.storeRoot();

const writerB = await EmbeddedStorage.start({
  storageDirectory,
  storageTarget: target,
  lockStrategy: "optimistic",
  rootFactory: () => ({ counter: 0, events: [] }),
});

let externalWriteDone = false;
const attempts = [];
const retried = await writerA.transaction(
  async ({ root, attempt, transactionId }) => {
    attempts.push({ attempt, transactionId, counter: root.counter });
    root.counter += 1;
    if (!externalWriteDone) {
      externalWriteDone = true;
      await writerB.transaction(
        ({ root: externalRoot }) => {
          externalRoot.counter += 10;
          externalRoot.events.push("external");
        },
        { mode: "pessimistic" },
      );
    }
    root.events.push(`writer-a-${attempt}`);
    return root.counter;
  },
  { mode: "optimistic", maxRetries: 2, retryDelayMs: 0 },
);

assert.equal(retried.lockMode, "optimistic");
assert.equal(retried.attempts, 2);
assert.deepEqual(attempts, [
  { attempt: 1, transactionId: 1, counter: 0 },
  { attempt: 2, transactionId: 2, counter: 10 },
]);
assert.equal(writerA.root.counter, 11);
assert.deepEqual(writerA.root.events, ["external", "writer-a-2"]);

await assert.rejects(
  () =>
    writerA.transaction(
      async ({ root }) => {
        root.counter += 1;
        await writerB.transaction(
          ({ root: externalRoot }) => {
            externalRoot.counter += 100;
            externalRoot.events.push("conflict");
          },
          { mode: "pessimistic" },
        );
      },
      { mode: "optimistic", maxRetries: 1, retryDelayMs: 0 },
    ),
  OptimisticLockError,
);

const afterConflict = await EmbeddedStorage.start({
  storageDirectory,
  storageTarget: target,
  lockStrategy: "optimistic",
  rootFactory: () => ({ counter: 0, events: [] }),
  readOnly: true,
});
assert.equal(afterConflict.root.counter, 111);
assert.deepEqual(afterConflict.root.events, ["external", "writer-a-2", "conflict"]);
await afterConflict.shutdown();

let releasePessimistic;
const firstMayCommit = new Promise((resolve) => {
  releasePessimistic = resolve;
});
const pessimisticOrder = [];
const first = writerA.transaction(
  async ({ root }) => {
    pessimisticOrder.push("first-start");
    root.events.push("first");
    await firstMayCommit;
    pessimisticOrder.push("first-end");
  },
  { mode: "pessimistic" },
);
const second = writerB.transaction(
  ({ root }) => {
    pessimisticOrder.push("second-start");
    root.events.push("second");
  },
  { mode: "pessimistic" },
);

await new Promise((resolve) => setTimeout(resolve, 25));
assert.deepEqual(pessimisticOrder, ["first-start"]);
releasePessimistic();
await Promise.all([first, second]);
assert.deepEqual(pessimisticOrder, ["first-start", "first-end", "second-start"]);

await writerA.transaction(
  async () => {
    await writerA.update((root) => {
      root.events.push("nested-update");
    });
    await assert.rejects(() => writerA.storeRoot(), TransactionScopeError);
    await assert.rejects(() => writerA.storeLazy("nested-lazy", { value: true }), TransactionScopeError);
    await assert.rejects(() => writerA.createLazyRef("new-lazy-ref", { value: true }), TransactionScopeError);
  },
  { mode: "pessimistic" },
);

const afterNestedUpdate = await EmbeddedStorage.start({
  storageDirectory,
  storageTarget: target,
  lockStrategy: "optimistic",
  rootFactory: () => ({ counter: 0, events: [] }),
  readOnly: true,
});
assert.equal(afterNestedUpdate.root.events.includes("nested-update"), true);
await afterNestedUpdate.shutdown();

class DocumentService {
  constructor(storage) {
    this.storage = storage;
  }

  async approve(id) {
    const document = this.storage.root.documents.find((item) => item.id === id);
    document.status = "approved";
    return document.status;
  }
}

const decoratorTarget = Object.getPrototypeOf(new DocumentService(writerA));
const descriptor = Object.getOwnPropertyDescriptor(decoratorTarget, "approve");
GraphVaultTransactional({ mode: "pessimistic", managerProperty: "storage" })(decoratorTarget, "approve", descriptor);
Object.defineProperty(decoratorTarget, "approve", descriptor);

const decoratorTargetStorage = new MemoryStorageTarget();
const decoratorStorage = await EmbeddedStorage.start({
  storageDirectory: "decorator-test",
  storageTarget: decoratorTargetStorage,
  lockStrategy: "optimistic",
  rootFactory: () => ({ documents: [{ id: "doc-1", status: "draft" }] }),
});
await decoratorStorage.storeRoot();
const service = new DocumentService(decoratorStorage);
assert.equal(await service.approve("doc-1"), "approved");

const afterDecorator = await EmbeddedStorage.start({
  storageDirectory: "decorator-test",
  storageTarget: decoratorTargetStorage,
  readOnly: true,
  rootFactory: () => ({ documents: [] }),
});
assert.equal(afterDecorator.root.documents[0].status, "approved");
await afterDecorator.shutdown();
await decoratorStorage.shutdown();

const staleMemoryLockTarget = new MemoryStorageTarget();
await staleMemoryLockTarget.acquireLock("locks/stale", 0);
await new Promise((resolve) => setTimeout(resolve, 5));
const recoveredMemoryLock = await staleMemoryLockTarget.acquireLock("locks/stale", 20, { staleLockTimeoutMs: 1 });
await recoveredMemoryLock.release();

const staleLockDirectory = await mkdtemp(join(tmpdir(), "graphvault-stale-lock-"));
try {
  const localTarget = new LocalFilesystemTarget();
  const staleLockPath = join(staleLockDirectory, "store.lock");
  await writeFile(staleLockPath, JSON.stringify({ createdAt: new Date(Date.now() - 60_000).toISOString() }));
  const recoveredLocalLock = await localTarget.acquireLock(staleLockPath, 20, { staleLockTimeoutMs: 1_000 });
  await recoveredLocalLock.release();
} finally {
  await rm(staleLockDirectory, { recursive: true, force: true });
}

await writerB.shutdown();
await writerA.shutdown();
