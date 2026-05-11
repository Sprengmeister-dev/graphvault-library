import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EmbeddedStorage, MemoryStorageTarget, StorageLockError } from "../dist/index.js";

const workingDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-tests-"));
const backupDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-backup-"));
const maximumWriteDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-maximum-"));
const nestedMutationDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-nested-"));
const consistentBackupDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-consistent-backup-"));
const integrityDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-integrity-"));

try {
  const writeable = await EmbeddedStorage.start({
    storageDirectory: workingDirectory,
    rootFactory: () => ({
      docs: [{ id: "doc-1", title: "First" }, { id: "doc-2", title: "Second" }],
    }),
  });

  await writeable.storeRoot();

  const verified = await writeable.verify();
  assert.equal(verified.ok, true);
  assert.equal(verified.checkedObjects >= 2, true);
  const operations = await writeable.operations();
  assert.equal(operations.status, "healthy");
  assert.equal(operations.publishedTransactionId, 1);
  assert.equal(operations.latestJournalTransactionId, 1);
  assert.equal(operations.pendingWalCommits, 0);
  assert.equal(operations.walPrepareFiles, 1);
  assert.equal(operations.walCommitFiles, 1);
  assert.equal(operations.objectCount >= 2, true);
  assert.equal(typeof operations.latestTransactionHash, "string");
  await writeable.gvql('MATCH (doc) WHERE doc.id = "doc-1" SET doc.title = "First updated"');
  const updated = await writeable.gvql('MATCH (doc) WHERE doc.id = "doc-1" RETURN doc.title AS title');
  assert.equal(updated.rows[0].title, "First updated");

  const maintenance = await writeable.maintain({ keepSnapshots: 2, verify: false });
  assert.equal("verification" in maintenance, false);
  assert.equal(maintenance.compaction.kept >= 1, true);

  const readOnly = await EmbeddedStorage.start({
    storageDirectory: workingDirectory,
    rootFactory: () => ({ docs: [] }),
    readOnly: true,
  });

  const readOnlyQuery = await readOnly.gvql('MATCH (doc) WHERE doc.id IS NOT NULL RETURN doc.id AS id ORDER BY doc.id ASC');
  assert.equal(readOnlyQuery.rows.length, 2);
  await assert.rejects(
    () => readOnly.gvql('MATCH (doc) WHERE doc.id = "doc-2" SET doc.title = "blocked"'),
    /Storage manager is read-only/,
  );
  await assert.rejects(() => readOnly.store({}), /Storage manager is read-only/);
  await readOnly.shutdown();

  const backupResult = await writeable.backup({ storageDirectory: backupDirectory });
  assert.equal(typeof backupResult.transactionId, "number");
  assert.equal(typeof backupResult.filesCopied, "number");
  assert.equal(backupResult.consistent, true);
  await writeable.shutdown();
  await assert.rejects(() => access(join(backupDirectory, "LOCK")));
  await assert.rejects(() => access(join(backupDirectory, "LOCK.fencing-token")));

  const restored = await EmbeddedStorage.start({
    storageDirectory: backupDirectory,
    rootFactory: () => ({ docs: [] }),
  });
  const restoredQuery = await restored.gvql('MATCH (doc) WHERE doc.id IS NOT NULL RETURN doc.title AS title ORDER BY doc.id ASC');
  assert.equal(restoredQuery.rows.length, 2);
  assert.equal(restoredQuery.rows[0].title, "First updated");
  assert.equal(restoredQuery.rows[1].title, "Second");
  restored.root.docs.push({ id: "doc-restored", title: "Writable restore" });
  await restored.storeRoot();
  await restored.shutdown();

  const manifestPath = join(backupDirectory, "manifest.json");
  await access(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.format, "graphvault-manifest");
  assert.equal(Array.isArray(manifest.objectIds), true);

  const maximumWrite = await EmbeddedStorage.start({
    storageDirectory: maximumWriteDirectory,
    rootFactory: () => ({
      docs: [{ id: "doc-fast", title: "Binary only" }],
    }),
    writeProfile: "maximum",
  });
  await maximumWrite.storeRoot();
  await maximumWrite.shutdown();
  assert.deepEqual(await readdir(join(maximumWriteDirectory, "objects")), []);
  assert.equal((await readdir(join(maximumWriteDirectory, "objects-bin"))).length >= 2, true);
  assert.deepEqual(await readdir(join(maximumWriteDirectory, "snapshots")), []);
  const maximumRestored = await EmbeddedStorage.start({
    storageDirectory: maximumWriteDirectory,
    rootFactory: () => ({ docs: [] }),
    readOnly: true,
  });
  assert.equal(maximumRestored.root.docs[0].title, "Binary only");
  await maximumRestored.shutdown();

  const nestedMutations = await EmbeddedStorage.start({
    storageDirectory: nestedMutationDirectory,
    rootFactory: () => ({ items: [], nested: { count: 1 } }),
  });
  nestedMutations.root.items.push("a");
  await nestedMutations.storeRoot();
  nestedMutations.root.items.push("b");
  await nestedMutations.storeRoot();
  await nestedMutations.update((root) => {
    root.nested.count = 2;
  });
  await nestedMutations.shutdown();

  const nestedMaintainer = await EmbeddedStorage.start({
    storageDirectory: nestedMutationDirectory,
    rootFactory: () => ({ items: [], nested: { count: 0 } }),
  });
  const nestedMaintenance = await nestedMaintainer.maintain({ keepSnapshots: 2 });
  assert.equal(nestedMaintenance.verification.ok, true);
  await nestedMaintainer.shutdown();

  const nestedReloaded = await EmbeddedStorage.start({
    storageDirectory: nestedMutationDirectory,
    rootFactory: () => ({ items: [], nested: { count: 0 } }),
    readOnly: true,
    readCommittedWal: false,
  });
  assert.deepEqual(nestedReloaded.root.items, ["a", "b"]);
  assert.equal(nestedReloaded.root.nested.count, 2);
  await nestedReloaded.shutdown();

  const backupLockTarget = new MemoryStorageTarget();
  const lockedBackupStore = await EmbeddedStorage.start({
    storageDirectory: "consistent-backup-lock",
    storageTarget: backupLockTarget,
    lockStrategy: "pessimistic",
    lockTimeoutMs: 1,
    rootFactory: () => ({ items: ["safe"] }),
  });
  await lockedBackupStore.storeRoot();
  const externalLock = await backupLockTarget.acquireLock("consistent-backup-lock/LOCK", 0);
  await assert.rejects(
    () => lockedBackupStore.backup({ storageDirectory: "consistent-backup-copy", storageTarget: backupLockTarget }),
    StorageLockError,
  );
  await externalLock.release();
  const consistentBackup = await lockedBackupStore.backup({
    storageDirectory: consistentBackupDirectory,
    storageTarget: backupLockTarget,
  });
  assert.equal(consistentBackup.consistent, true);
  await lockedBackupStore.shutdown();

  const auditedStore = await EmbeddedStorage.start({
    storageDirectory: integrityDirectory,
    rootFactory: () => ({ ledger: [] }),
  });
  auditedStore.root.ledger.push({ id: "entry-1", amount: 100 });
  await auditedStore.storeRoot();
  auditedStore.root.ledger.push({ id: "entry-2", amount: -15 });
  await auditedStore.storeRoot();
  const auditedResult = await auditedStore.transaction(
    ({ root }) => {
      root.ledger.push({ id: "entry-3", amount: 40 });
    },
    {
      metadata: {
        actor: "ops@example.com",
        reason: "reconcile ledger",
        source: "unit-test",
        traceId: "trace-audit-1",
        tags: ["audit", "ledger"],
      },
    },
  );
  assert.equal(auditedResult.metadata.metadata.actor, "ops@example.com");
  const auditedVerification = await auditedStore.verify();
  assert.equal(auditedVerification.ok, true);
  assert.equal(auditedVerification.checkedIntegrityHashes >= 3, true);
  const thirdTransactionPath = join(integrityDirectory, "transactions", "transaction-000000000003.json");
  const thirdTransaction = JSON.parse(await readFile(thirdTransactionPath, "utf8"));
  assert.equal(thirdTransaction.metadata.actor, "ops@example.com");
  assert.equal(thirdTransaction.metadata.reason, "reconcile ledger");
  thirdTransaction.targetCount += 1;
  await writeFile(thirdTransactionPath, `${JSON.stringify(thirdTransaction, null, 2)}\n`);
  const tamperedVerification = await auditedStore.verify();
  assert.equal(tamperedVerification.ok, false);
  assert.equal(tamperedVerification.errors.some((error) => error.includes("invalid transactionHash")), true);
  await auditedStore.shutdown();
} finally {
  await rm(workingDirectory, { recursive: true, force: true });
  await rm(backupDirectory, { recursive: true, force: true });
  await rm(maximumWriteDirectory, { recursive: true, force: true });
  await rm(nestedMutationDirectory, { recursive: true, force: true });
  await rm(consistentBackupDirectory, { recursive: true, force: true });
  await rm(integrityDirectory, { recursive: true, force: true });
}
