import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EmbeddedStorage, MemoryStorageTarget, StorageLockError } from "../dist/index.js";

const workingDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-tests-"));
const backupDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-backup-"));
const productionWriteDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-production-"));
const inspectWriteDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-inspect-"));
const nestedMutationDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-nested-"));
const consistentBackupDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-consistent-backup-"));
const integrityDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-integrity-"));
const productionSafetyDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-safety-production-"));
const unsafeSafetyDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-safety-unsafe-"));
const migrationDirectory = await mkdtemp(join(tmpdir(), "graphvault-storage-migrations-"));

try {
  const writeable = await EmbeddedStorage.start({
    storageDirectory: workingDirectory,
    writeProfile: "inspect",
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
  assert.equal(operations.schemaVersion, 0);
  assert.equal(operations.latestJournalTransactionId, 1);
  assert.equal(operations.pendingWalCommits, 0);
  assert.equal(operations.walPrepareFiles, 1);
  assert.equal(operations.walCommitFiles, 1);
  assert.equal(operations.objectCount >= 2, true);
  assert.equal(typeof operations.latestTransactionHash, "string");
  const defaultSafety = await writeable.safetyProfile();
  assert.equal(defaultSafety.status, "warning");
  assert.equal(defaultSafety.issues.some((issue) => issue.code === "stale-lock-recovery-disabled"), true);
  assert.equal(defaultSafety.hashChain, "present");
  const defaultHealth = await writeable.health();
  assert.equal(defaultHealth.ok, true);
  assert.equal(defaultHealth.status, "warning");
  assert.equal(defaultHealth.operations.status, "healthy");
  assert.equal(defaultHealth.safety.status, "warning");
  assert.equal(defaultHealth.verification.ok, true);
  assert.equal(typeof defaultHealth.checkedAt, "string");
  const lightweightHealth = await writeable.health({ verify: false });
  assert.equal(lightweightHealth.ok, true);
  assert.equal(lightweightHealth.status, "warning");
  assert.equal("verification" in lightweightHealth, false);

  const rootOnlySubtree = await writeable.loadSubtree({ depth: 0 });
  assert.equal(rootOnlySubtree.depth, 0);
  assert.equal(rootOnlySubtree.objectIds.length, 1);
  assert.equal(rootOnlySubtree.complete, false);
  assert.equal(typeof rootOnlySubtree.rootObjectId, "string");
  assert.equal(Object.keys(rootOnlySubtree.envelope.nodes).length, 1);
  const docsReference = rootOnlySubtree.truncatedReferences.find((reference) => reference.path === "docs");
  assert.ok(docsReference);
  assert.equal(docsReference.fromObjectId, rootOnlySubtree.rootObjectId);

  const rootWithChildren = await writeable.loadSubtree(rootOnlySubtree.rootObjectId, { depth: 1 });
  assert.equal(rootWithChildren.objectIds.includes(rootOnlySubtree.rootObjectId), true);
  assert.equal(rootWithChildren.objectIds.includes(docsReference.toObjectId), true);
  assert.equal(rootWithChildren.truncatedReferences.some((reference) => reference.fromObjectId === docsReference.toObjectId), true);

  const docsSubtree = await writeable.loadSubtree(docsReference.toObjectId, { depth: 1 });
  assert.equal(docsSubtree.rootObjectId, docsReference.toObjectId);
  assert.deepEqual(docsSubtree.envelope.root, { $ref: docsReference.toObjectId });
  assert.equal(docsSubtree.objectIds.length, 3);
  assert.equal(docsSubtree.complete, true);
  await assert.rejects(() => writeable.loadSubtree({ depth: -1 }), /non-negative integer/);
  await assert.rejects(() => writeable.loadSubtree("missing", { depth: 1 }), /not present in the current manifest/);

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

  const productionWrite = await EmbeddedStorage.start({
    storageDirectory: productionWriteDirectory,
    rootFactory: () => ({
      docs: [{ id: "doc-fast", title: "Binary only" }],
    }),
  });
  await productionWrite.storeRoot();
  await productionWrite.shutdown();
  assert.deepEqual(await readdir(join(productionWriteDirectory, "objects")), []);
  assert.equal((await readdir(join(productionWriteDirectory, "objects-bin"))).length >= 2, true);
  assert.deepEqual(await readdir(join(productionWriteDirectory, "snapshots")), []);
  const productionRestored = await EmbeddedStorage.start({
    storageDirectory: productionWriteDirectory,
    rootFactory: () => ({ docs: [] }),
    readOnly: true,
  });
  assert.equal(productionRestored.root.docs[0].title, "Binary only");
  await productionRestored.shutdown();

  const inspectWrite = await EmbeddedStorage.start({
    storageDirectory: inspectWriteDirectory,
    rootFactory: () => ({
      docs: [{ id: "doc-inspect", title: "Inspectable" }],
    }),
    writeProfile: "inspect",
  });
  await inspectWrite.storeRoot();
  await inspectWrite.shutdown();
  assert.equal((await readdir(join(inspectWriteDirectory, "objects"))).length >= 2, true);
  assert.equal((await readdir(join(inspectWriteDirectory, "objects-bin"))).length >= 2, true);
  assert.equal((await readdir(join(inspectWriteDirectory, "snapshots"))).length >= 1, true);

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

  const productionSafe = await EmbeddedStorage.start({
    storageDirectory: productionSafetyDirectory,
    rootFactory: () => ({ ledger: [{ id: "entry-1", amount: 100 }] }),
    staleLockTimeoutMs: 60_000,
    transactionLog: "full",
    writeDurability: "strict",
    writeSnapshots: true,
    commitValidators: [
      ({ root }) => {
        assert.equal(Array.isArray(root.ledger), true);
      },
    ],
  });
  await productionSafe.storeRoot();
  const safeProfile = await productionSafe.safetyProfile();
  assert.equal(safeProfile.status, "production-ready");
  assert.equal(safeProfile.score, 100);
  assert.equal(safeProfile.pendingRecovery, false);
  assert.equal(safeProfile.staleLockRecovery, true);
  assert.deepEqual(safeProfile.issues, []);
  const safeHealth = await productionSafe.health();
  assert.equal(safeHealth.ok, true);
  assert.equal(safeHealth.status, "healthy");
  assert.equal(safeHealth.safety.score, 100);
  await productionSafe.shutdown();

  const unsafeStore = await EmbeddedStorage.start({
    storageDirectory: unsafeSafetyDirectory,
    rootFactory: () => ({ cache: [{ id: "cache-1" }] }),
    transactionLog: "off",
    writeProfile: "production",
  });
  await unsafeStore.storeRoot();
  const unsafeProfile = await unsafeStore.safetyProfile();
  assert.equal(unsafeProfile.status, "unsafe");
  assert.equal(unsafeProfile.durability, "relaxed");
  assert.equal(unsafeProfile.writeSnapshots, false);
  assert.equal(unsafeProfile.issues.some((issue) => issue.code === "transaction-log-disabled" && issue.severity === "critical"), true);
  assert.equal(unsafeProfile.issues.some((issue) => issue.code === "relaxed-durability"), true);
  const unsafeHealth = await unsafeStore.health({ verify: false });
  assert.equal(unsafeHealth.ok, false);
  assert.equal(unsafeHealth.status, "unsafe");
  assert.equal(unsafeHealth.safety.status, "unsafe");
  await unsafeStore.shutdown();

  const migrationV0 = await EmbeddedStorage.start({
    storageDirectory: migrationDirectory,
    schemaVersion: 0,
    rootFactory: () => ({ people: [{ fullName: "Ada Lovelace" }] }),
  });
  await migrationV0.storeRoot();
  await migrationV0.shutdown();

  const migrations = [
    {
      version: 1,
      name: "split-person-name",
      up: ({ root }) => {
        for (const person of root.people) {
          const [firstName, ...lastName] = person.fullName.split(" ");
          person.firstName = firstName;
          person.lastName = lastName.join(" ");
          delete person.fullName;
        }
      },
      down: ({ root }) => {
        for (const person of root.people) {
          person.fullName = `${person.firstName} ${person.lastName}`.trim();
          delete person.firstName;
          delete person.lastName;
        }
      },
    },
    {
      version: 2,
      name: "add-active-flag",
      up: ({ root }) => {
        for (const person of root.people) {
          person.active = true;
        }
      },
      down: ({ root }) => {
        for (const person of root.people) {
          delete person.active;
        }
      },
    },
  ];

  const migrationStore = await EmbeddedStorage.start({
    storageDirectory: migrationDirectory,
    rootFactory: () => ({ people: [] }),
    schemaVersion: 2,
    schemaMigrations: migrations,
  });
  assert.equal(migrationStore.currentSchemaVersion(), 0);
  const migrationStatus = migrationStore.migrationStatus();
  assert.equal(migrationStatus.currentVersion, 0);
  assert.equal(migrationStatus.targetVersion, 2);
  assert.deepEqual(migrationStatus.pending.map((step) => [step.version, step.direction]), [[1, "up"], [2, "up"]]);
  const migrated = await migrationStore.migrateTo();
  assert.equal(migrated.fromVersion, 0);
  assert.equal(migrated.toVersion, 2);
  assert.equal(migrated.applied.length, 2);
  assert.equal(migrationStore.currentSchemaVersion(), 2);
  assert.deepEqual(migrationStore.root.people, [{ firstName: "Ada", lastName: "Lovelace", active: true }]);
  const migratedManifest = JSON.parse(await readFile(join(migrationDirectory, "manifest.json"), "utf8"));
  assert.equal(migratedManifest.schemaVersion, 2);
  const migrationTransactions = await readdir(join(migrationDirectory, "transactions"));
  const latestMigrationRecord = JSON.parse(
    await readFile(join(migrationDirectory, "transactions", migrationTransactions.sort().at(-1)), "utf8"),
  );
  assert.equal(latestMigrationRecord.schemaVersion, 2);
  assert.deepEqual(latestMigrationRecord.metadata.schemaMigration, {
    version: 2,
    name: "add-active-flag",
    direction: "up",
    fromVersion: 1,
    toVersion: 2,
  });

  const downMigrated = await migrationStore.migrateTo(0);
  assert.equal(downMigrated.fromVersion, 2);
  assert.equal(downMigrated.toVersion, 0);
  assert.deepEqual(downMigrated.applied.map((step) => [step.version, step.direction]), [[2, "down"], [1, "down"]]);
  assert.deepEqual(migrationStore.root.people, [{ fullName: "Ada Lovelace" }]);
  assert.equal(migrationStore.currentSchemaVersion(), 0);
  await migrationStore.shutdown();

  const migrationReload = await EmbeddedStorage.start({
    storageDirectory: migrationDirectory,
    rootFactory: () => ({ people: [] }),
    schemaVersion: 2,
    schemaMigrations: migrations,
    migrateOnStart: true,
  });
  assert.equal(migrationReload.currentSchemaVersion(), 2);
  assert.deepEqual(migrationReload.root.people, [{ firstName: "Ada", lastName: "Lovelace", active: true }]);
  await migrationReload.shutdown();
} finally {
  await rm(workingDirectory, { recursive: true, force: true });
  await rm(backupDirectory, { recursive: true, force: true });
  await rm(productionWriteDirectory, { recursive: true, force: true });
  await rm(inspectWriteDirectory, { recursive: true, force: true });
  await rm(nestedMutationDirectory, { recursive: true, force: true });
  await rm(consistentBackupDirectory, { recursive: true, force: true });
  await rm(integrityDirectory, { recursive: true, force: true });
  await rm(productionSafetyDirectory, { recursive: true, force: true });
  await rm(unsafeSafetyDirectory, { recursive: true, force: true });
  await rm(migrationDirectory, { recursive: true, force: true });
}
