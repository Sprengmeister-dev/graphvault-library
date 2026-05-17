import { join } from "node:path";
import { AsyncMutex } from "../concurrency/mutex.js";
import { GraphSerializer } from "../core/serializer.js";
import { StorageLayout } from "./storage-layout.js";
import { StorageReader } from "./storage-reader.js";
import { verifyStorage } from "./storage-verifier.js";
import { StorageWriter } from "./storage-writer.js";
import { StorageCommitter, sortedObjectIds } from "./storage-committer.js";
import { resolveStorageWriteOptions, type ResolvedStorageWriteOptions } from "./storage-write-options.js";
import { copyStorageTargetTree, LocalFilesystemTarget } from "./storage-target.js";
import { loadSubtreeFromEnvelope, loadSubtreeFromManifest } from "./storage-subtree.js";
import { assessStorageSafety } from "./storage-safety.js";
import { buildStorageHealthReport } from "./storage-health.js";
import { collectStorageGarbage } from "./storage-garbage.js";
import { collectObjectIdsForTargets } from "./storage-object-collector.js";
import { verifyStorageIndexRecord } from "./storage-index-maintenance.js";
import { buildStorageIndexRecord, graphIndexFromStorageRecord, isUsableStorageIndexRecord, resolveStorageIndexOptions, storageIndexStatus, type ResolvedStorageIndexOptions } from "./storage-index.js";
import { migrationContext, migrationMetadata, migrationPlan, sortedSchemaMigrations, targetSchemaVersion } from "./storage-migrations.js";
import { bindStorageLazyRefs, storeLoadedStorageLazyRefs } from "./storage-lazy-helpers.js";
import { isIterable, replaceObjectContents } from "./storage-root-helpers.js";
import { Storer } from "./storer.js";
import { LazyRef } from "../lazy/lazy-ref.js";
import { OptimisticLockError, ReadonlyStorageError, StorageNotStartedError, TransactionScopeError } from "../core/errors.js";
import { executeGvqlStatement } from "../gvql/gvql-executor.js";
import { parseGvql } from "../gvql/gvql-parser.js";
import type {
  CompactionResult,
  BackupResult,
  GarbageCollectionResult,
  SerializedEnvelope,
  StorageManagerOptions,
  StorageLockOptions,
  StorageStatus,
  StorageOperationsStatus,
  StorageSafetyProfile,
  StorageHealthOptions,
  StorageHealthReport,
  SubtreeLoadOptions,
  SubtreeLoadResult,
  StorageTarget,
  StorageTargetLock,
  StoreMetadata,
  StoreMode,
  GraphVaultTransactionContext,
  GraphVaultTransactionOptions,
  GraphVaultTransactionResult,
  StorageMigrationResult,
  StorageMigrationStatus,
  StorageMigrationStepResult,
  StorageSchemaMigration,
  StorageIndexRecord,
  StorageIndexStatus,
  StorageIndexVerificationResult,
  TransactionLockMode,
  TransactionMetadata,
  VerificationResult,
  MaintenanceResult,
  MaintenanceOptions,
} from "../core/types.js";
import type { GvqlExecutionOptions, GvqlResult } from "../gvql/gvql-types.js";
import type { GvqlGraphIndex } from "../gvql/gvql-types.js";

/** Coordinates a GraphVault store, including startup recovery, transactions, GVQL, indexes, backups, and maintenance. */
export class StorageManager<TRoot = unknown> {
  private readonly options: Required<Pick<StorageManagerOptions<TRoot>, "lockTimeoutMs" | "housekeepingIntervalMs">> &
    StorageManagerOptions<TRoot>;
  private readonly serializer: GraphSerializer;
  private readonly target: StorageTarget;
  private readonly layout: StorageLayout;
  private readonly reader: StorageReader;
  private readonly writer: StorageWriter;
  private readonly committer: StorageCommitter;
  private readonly writeOptions: ResolvedStorageWriteOptions;
  private readonly indexOptions: ResolvedStorageIndexOptions;
  private readonly mutex = new AsyncMutex();
  private rootValue?: TRoot;
  private started = false;
  private transactionId = 0;
  private recoveredFrom: "manifest" | "snapshot" | "wal" | "empty" | undefined;
  private readonly persistedObjectIds = new Set<string>();
  private readonly persistedObjectVersions = new Map<string, number>();
  private typeDictionarySignature = "";
  private lockHandle: StorageTargetLock | undefined;
  private housekeepingTimer: NodeJS.Timeout | undefined;
  private transactionDepth = 0;
  private schemaVersion = 0;
  private storageIndexRecord: StorageIndexRecord | undefined;

  /** Creates a manager for one store; call start() before reading or writing the root. */
  constructor(options: StorageManagerOptions<TRoot>, serializer = new GraphSerializer(options.types ?? [])) {
    this.options = { lockTimeoutMs: 5_000, housekeepingIntervalMs: 0, ...options };
    this.writeOptions = resolveStorageWriteOptions(this.options);
    this.indexOptions = resolveStorageIndexOptions(this.options.indexes);
    this.layout = new StorageLayout(this.options.storageDirectory, this.options.channelCount ?? 1);
    this.serializer = serializer;
    this.target = options.storageTarget ?? new LocalFilesystemTarget({ syncWrites: this.writeOptions.durability === "strict" });
    this.reader = new StorageReader(this.target, this.layout);
    this.writer = new StorageWriter(this.target, this.layout, { ...this.writeOptions, indexes: this.indexOptions });
    this.committer = new StorageCommitter({
      target: this.target,
      layout: this.layout,
      writer: this.writer,
      writeOptions: this.writeOptions,
      transactionLogEnabled: () => this.transactionLogEnabled,
      validateCommit: (envelope, transactionId) => this.runCommitValidators(envelope, transactionId),
      beforePublish: () => this.writeTypeDictionaryIfChanged(),
      readLatestTransactionRecord: () => this.reader.readLatestTransactionRecord(),
      commitState: (transactionId, objectVersions, envelope) => {
        this.transactionId = transactionId;
        this.replacePersistedObjectVersions(objectVersions);
        this.storageIndexRecord = envelope ? this.indexRecordForEnvelope(envelope, transactionId) : undefined;
      },
      schemaVersion: () => this.schemaVersion,
    });
  }

  /** Returns the loaded application root and throws when the manager has not been started. */
  get root(): TRoot {
    if (!this.started) {
      throw new StorageNotStartedError("Storage manager has not been started.");
    }
    return this.rootValue as TRoot;
  }

  /** Initializes storage directories, recovers committed WAL entries, loads or creates the root, and starts housekeeping. */
  async start(): Promise<this> {
    if (this.started) {
      return this;
    }
    await this.target.ensureDirectory(this.layout.snapshotsDirectory);
    await this.target.ensureDirectory(this.layout.lazyDirectory);
    await this.target.ensureDirectory(this.layout.objectsDirectory);
    await this.target.ensureDirectory(this.layout.binaryObjectsDirectory);
    await this.target.ensureDirectory(this.layout.transactionsDirectory);
    await this.target.ensureDirectory(this.layout.walDirectory);
    for (const directory of this.layout.channelDirectories()) {
      await this.target.ensureDirectory(join(directory, "objects"));
      await this.target.ensureDirectory(join(directory, "objects-bin"));
    }
    if (!this.options.readOnly && this.lockStrategy === "startup") {
      await this.acquireLock();
      if (this.shouldRecoverCommittedWal) {
        await this.recoverCommittedWalLocked(this.lockHandle as StorageTargetLock);
      }
      await this.writeTypeDictionaryIfChanged();
    } else if (!this.options.readOnly && this.shouldRecoverCommittedWal) {
      await this.withWriteLock((lock) => this.recoverCommittedWalLocked(lock));
    }

    const loaded = await this.reader.loadExistingEnvelope({ includeWal: this.shouldReadCommittedWal });
    if (loaded) {
      const loadedRoot = this.serializer.deserialize<TRoot>(loaded.envelope);
      this.rootValue = this.fillCustomRoot(loadedRoot, loaded.envelope);
      this.transactionId = loaded.transactionId;
      this.recoveredFrom = loaded.source;
      this.replacePersistedObjectVersions(loaded.objectVersions);
      this.schemaVersion = loaded.schemaVersion;
      this.storageIndexRecord = await this.reader.readStorageIndex();
      if (loaded.source === "snapshot" && !this.options.readOnly) {
        await this.repairObjectStoreFromEnvelope(loaded.envelope, loaded.transactionId);
      }
    } else {
      this.rootValue = this.options.rootFactory();
      this.recoveredFrom = "empty";
      this.schemaVersion = this.targetSchemaVersion();
      this.storageIndexRecord = undefined;
    }
    this.bindLazyRefs(this.rootValue);
    this.started = true;
    if (!this.options.readOnly && this.options.migrateOnStart) {
      await this.migrateTo(this.targetSchemaVersion());
    }
    this.startHousekeeping();
    return this;
  }

  /** Stops housekeeping and releases any startup lock held by this manager. */
  async shutdown(): Promise<void> {
    this.stopHousekeeping();
    if (this.lockHandle) {
      await this.lockHandle.release();
      this.lockHandle = undefined;
    }
    this.started = false;
  }

  /** NestJS lifecycle hook that releases GraphVault resources during application shutdown. */
  async onApplicationShutdown(): Promise<void> {
    await this.shutdown();
  }

  /** Commits the full reachable root graph as the next transaction. */
  async storeRoot(): Promise<StoreMetadata> {
    this.assertStarted();
    this.assertWritable();
    this.assertOutsideTransaction("storeRoot()");
    return this.mutex.runExclusive(() => this.writeWithConflictCheck((lock) => this.storeLocked("eager", [this.root], lock)));
  }

  /** Commits one modified object, using a full root write when the root itself is passed. */
  async store(_modifiedObject: unknown): Promise<StoreMetadata> {
    this.assertStarted();
    this.assertWritable();
    this.assertOutsideTransaction("store()");
    const mode: StoreMode = _modifiedObject === this.rootValue ? "eager" : "standard";
    return this.mutex.runExclusive(() => this.writeWithConflictCheck((lock) => this.storeLocked(mode, [_modifiedObject], lock)));
  }

  /** Commits multiple modified objects as one transaction. */
  async storeAll(instances: Iterable<unknown>): Promise<StoreMetadata>;
  /** Commits multiple modified objects as one transaction. */
  async storeAll(...instances: unknown[]): Promise<StoreMetadata>;
  /** Commits multiple modified objects as one transaction. */
  async storeAll(firstOrInstances: Iterable<unknown> | unknown, ...rest: unknown[]): Promise<StoreMetadata> {
    this.assertStarted();
    this.assertWritable();
    this.assertOutsideTransaction("storeAll()");
    const targets = rest.length > 0 || !isIterable(firstOrInstances) ? [firstOrInstances, ...rest] : Array.from(firstOrInstances);
    return this.mutex.runExclusive(() => this.writeWithConflictCheck((lock) => this.storeLocked("standard", targets, lock)));
  }

  /** Creates a storer for batching explicit objects before one standard commit. */
  createStorer(): Storer {
    return new Storer(this, "standard");
  }

  /** Creates a storer for explicitly persisting lazy references and lazy collection segments. */
  createLazyStorer(): Storer {
    return new Storer(this, "lazy");
  }

  /** Creates a storer that rewrites the full reachable graph for maximum consistency after broad changes. */
  createEagerStorer(): Storer {
    return new Storer(this, "eager");
  }

  /** Commits targets collected by a Storer using the storer's selected write mode. */
  async commitStorer(mode: StoreMode, targets: readonly unknown[]): Promise<StoreMetadata> {
    this.assertStarted();
    this.assertWritable();
    this.assertOutsideTransaction("storer.commit()");
    return this.mutex.runExclusive(() => this.writeWithConflictCheck((lock) => this.storeLocked(mode, targets, lock)));
  }

  /** Mutates the loaded root, rolls back in-memory changes if the callback fails, and commits once on success. */
  async update<T>(mutator: (root: TRoot) => T | Promise<T>, storeTarget?: (root: TRoot) => unknown): Promise<T> {
    this.assertStarted();
    this.assertWritable();
    if (this.inTransaction) {
      return mutator(this.root);
    }
    return this.mutex.runExclusive(async () => {
      const rollback = this.serializer.deserialize<TRoot>(this.serializer.serialize(this.rootValue));
      this.bindLazyRefs(rollback);
      try {
        const result = await mutator(this.root);
        await this.writeWithConflictCheck((lock) => {
          const target = storeTarget ? storeTarget(this.root) : this.root;
          return this.storeLocked(storeTarget ? "standard" : "eager", [target], lock);
        });
        return result;
      } catch (error) {
        this.rootValue = rollback;
        throw error;
      }
    });
  }

  /** Runs a callback against the root and commits its changes atomically with pessimistic or optimistic locking. */
  async transaction<T>(
    work: (context: GraphVaultTransactionContext<TRoot>) => T | Promise<T>,
    options: GraphVaultTransactionOptions<TRoot> = {},
  ): Promise<GraphVaultTransactionResult<T>> {
    this.assertStarted();
    this.assertWritable();
    const mode = options.mode ?? this.defaultTransactionMode();
    return mode === "optimistic" ? this.optimisticTransaction(work, options) : this.pessimisticTransaction(work, options);
  }

  /** Creates, binds, and persists a LazyRef under a stable key. */
  async createLazyRef<T>(key: string, initialValue: T): Promise<LazyRef<T>> {
    this.assertStarted();
    this.assertWritable();
    this.assertOutsideTransaction("createLazyRef()");
    const ref = new LazyRef<T>(key, initialValue);
    ref.bind((lazyKey) => this.loadLazy<T>(lazyKey), (lazyKey, value) => this.storeLazy(lazyKey, value));
    await ref.store();
    return ref;
  }

  /** Loads and deserializes a lazy value by key from the lazy storage area. */
  async loadLazy<T>(key: string): Promise<T> {
    const content = await this.target.readText(join(this.layout.lazyDirectory, `${encodeURIComponent(key)}.json`));
    return this.serializer.deserialize<T>(JSON.parse(content) as SerializedEnvelope);
  }

  /** Serializes and writes a lazy value under its stable key. */
  async storeLazy<T>(key: string, value: T): Promise<void> {
    this.assertStarted();
    this.assertWritable();
    this.assertOutsideTransaction("storeLazy()");
    await this.writer.writeJson(join(this.layout.lazyDirectory, `${encodeURIComponent(key)}.json`), this.serializer.serialize(value));
  }

  /** Removes older snapshots while keeping the current pointer and the requested number of recent snapshots. */
  async compact(keepLatest = 2): Promise<CompactionResult> {
    this.assertStarted();
    this.assertWritable();
    const current = await this.reader.readCurrentPointer();
    if (!current) {
      return { kept: 0, removed: 0 };
    }
    const snapshots = (await this.target.list(this.layout.snapshotsDirectory))
      .filter((name) => name.startsWith("snapshot-") && name.endsWith(".json"))
      .sort();
    const keep = new Set(snapshots.slice(Math.max(0, snapshots.length - keepLatest)));
    keep.add(current);
    let removed = 0;
    for (const snapshot of snapshots) {
      if (!keep.has(snapshot)) {
        await this.target.remove(join(this.layout.snapshotsDirectory, snapshot));
        removed++;
      }
    }
    return { kept: snapshots.length - removed, removed };
  }

  /** Removes persisted object, binary, and lazy records that are no longer reachable from the manifest. */
  async collectGarbage(): Promise<GarbageCollectionResult> {
    this.assertStarted();
    this.assertWritable();
    return this.mutex.runExclusive(() => this.collectGarbageLocked());
  }

  /** Copies the store to another directory or target, optionally holding a write lock for a consistent backup. */
  async backup(destination: { storageDirectory: string; storageTarget?: StorageTarget; consistent?: boolean }): Promise<BackupResult> {
    this.assertStarted();
    this.assertOutsideTransaction("backup()");
    const consistent = destination.consistent ?? true;
    const copy = async (): Promise<BackupResult> => {
      const filesCopied = await copyStorageTargetTree(
        this.target,
        destination.storageTarget ?? new LocalFilesystemTarget(),
        this.options.storageDirectory,
        destination.storageDirectory,
        { exclude: (relativePath) => relativePath === "LOCK" || relativePath === "LOCK.fencing-token" },
      );
      return { filesCopied, transactionId: this.transactionId, consistent };
    };
    if (!consistent) {
      return copy();
    }
    return this.mutex.runExclusive(() =>
      this.withWriteLock(async (lock) => {
        if (this.shouldRecoverCommittedWal) {
          await this.recoverCommittedWalLocked(lock);
        }
        await lock.assertValid();
        const result = await copy();
        await lock.assertValid();
        return result;
      }),
    );
  }

  /** Checks manifests, object records, transaction hashes, WAL state, lazy files, and optional indexes. */
  async verify(): Promise<VerificationResult> {
    return verifyStorage({
      target: this.target,
      lazyDirectory: this.layout.lazyDirectory,
      walDirectory: this.layout.walDirectory,
      readManifest: () => this.reader.readManifest(),
      readLatestTransactionRecord: () => this.reader.readLatestTransactionRecord(),
      readTransactionRecords: () => this.reader.readTransactionRecords(),
      readObjectRecord: (objectId, transactionId) => this.reader.readObjectRecord(objectId, transactionId),
      ...(this.indexOptions.mode !== "off" ? { readStorageIndex: () => this.reader.readStorageIndex() } : {}),
      readSnapshotEnvelope: async (snapshotFile) => JSON.parse(await this.target.readText(join(this.layout.snapshotsDirectory, snapshotFile))) as SerializedEnvelope,
    });
  }

  /** Runs garbage collection, snapshot compaction, and optional verification as one maintenance operation. */
  async maintain(options: MaintenanceOptions = {}): Promise<MaintenanceResult> {
    const garbageCollection = await this.collectGarbage();
    const compaction = await this.compact(options.keepSnapshots ?? 2);
    if (options.verify === false) {
      return { garbageCollection, compaction };
    }
    return { garbageCollection, compaction, verification: await this.verify() };
  }

  /** Runs garbage collection through a compatibility-style maintenance alias. */
  async issueFullGarbageCollection(): Promise<GarbageCollectionResult> {
    return this.collectGarbage();
  }

  /** Runs garbage collection through a compatibility-style maintenance alias. */
  async issueGarbageCollection(_timeBudgetMs?: number): Promise<GarbageCollectionResult> {
    return this.collectGarbage();
  }

  /** Runs full verification through a compatibility-style maintenance alias. */
  async issueFullFileCheck(): Promise<VerificationResult> {
    return this.verify();
  }

  /** Runs verification through a compatibility-style maintenance alias. */
  async issueFileCheck(_timeBudgetMs?: number): Promise<VerificationResult> {
    return this.verify();
  }

  /** Runs garbage collection, aggressive compaction, and optional verification. */
  async issueFullMaintenance(options: MaintenanceOptions = {}): Promise<MaintenanceResult> {
    return this.maintain({ keepSnapshots: 1, ...options });
  }

  /** Executes a GVQL query or mutation against the current root, committing mutations unless dryRun is enabled. */
  async gvql(query: string, options: GvqlExecutionOptions = {}): Promise<GvqlResult> {
    this.assertStarted();
    const statement = parseGvql(query);
    if (statement.kind === "update" && !options.dryRun) {
      this.assertWritable();
      this.assertOutsideTransaction("mutating gvql()");
    }
    return this.mutex.runExclusive(async () => {
      const execute = async (): Promise<GvqlResult> => {
        const envelope = this.serializer.serialize(this.rootValue);
        const graphIndex = options.graphIndex ?? this.graphIndexForGvql(envelope, statement.kind === "update" && !options.dryRun);
        const result = executeGvqlStatement(envelope, statement, {
          ...options,
          ...(graphIndex ? { graphIndex } : {}),
          allowMutations: statement.kind === "update" && !options.dryRun,
        });
        if (result.kind === "update" && !result.dryRun) {
          const nextRoot = this.serializer.deserialize<TRoot>(envelope);
          this.rootValue = this.fillCustomRoot(nextRoot, envelope);
          this.bindLazyRefs(this.rootValue);
          result.metadata = await this.withWriteLock(async (lock) =>
            this.storeEnvelopeLocked(envelope, "standard", result.changes.map((change) => change.objectId), lock),
          );
        }
        return result;
      };
      if (statement.kind === "update" && !options.dryRun) {
        return this.writeWithConflictCheck(async (lock) => {
          const envelope = this.serializer.serialize(this.rootValue);
          const graphIndex = options.graphIndex ?? this.graphIndexForGvql(envelope, true);
          const result = executeGvqlStatement(envelope, statement, {
            ...options,
            ...(graphIndex ? { graphIndex } : {}),
            allowMutations: true,
          });
          if (result.kind === "update" && !result.dryRun) {
            const nextRoot = this.serializer.deserialize<TRoot>(envelope);
            this.rootValue = this.fillCustomRoot(nextRoot, envelope);
            this.bindLazyRefs(this.rootValue);
            result.metadata = await this.storeEnvelopeLocked(envelope, "standard", result.changes.map((change) => change.objectId), lock);
          }
          return result;
        });
      }
      return execute();
    });
  }

  /** Executes GVQL in dry-run mode so updates return planned changes without committing them. */
  async previewGvql(query: string, options: Omit<GvqlExecutionOptions, "dryRun"> = {}): Promise<GvqlResult> {
    return this.gvql(query, { ...options, dryRun: true });
  }

  /** Loads a bounded serialized subgraph from the current store, optionally rooted at a specific object ID. */
  async loadSubtree(options?: SubtreeLoadOptions): Promise<SubtreeLoadResult>;
  /** Loads a bounded serialized subgraph from the current store, optionally rooted at a specific object ID. */
  async loadSubtree(rootObjectId: string, options?: SubtreeLoadOptions): Promise<SubtreeLoadResult>;
  /** Loads a bounded serialized subgraph from the current store, optionally rooted at a specific object ID. */
  async loadSubtree(rootObjectIdOrOptions: string | SubtreeLoadOptions = {}, options: SubtreeLoadOptions = {}): Promise<SubtreeLoadResult> {
    this.assertStarted();
    const subtreeOptions = typeof rootObjectIdOrOptions === "string" ? { ...options, rootObjectId: rootObjectIdOrOptions } : rootObjectIdOrOptions;
    return this.mutex.runExclusive(async () => {
      const manifest = await this.reader.readManifest();
      if (manifest) {
        return loadSubtreeFromManifest(this.reader, manifest, subtreeOptions);
      }
      return loadSubtreeFromEnvelope(this.serializer.serialize(this.rootValue), subtreeOptions, this.transactionId);
    });
  }

  private async collectGarbageLocked(): Promise<GarbageCollectionResult> {
    return collectStorageGarbage({ target: this.target, layout: this.layout, reader: this.reader });
  }

  /** Returns the in-memory manager status without performing storage verification. */
  status(): StorageStatus {
    return {
      started: this.started,
      readOnly: this.options.readOnly ?? false,
      storageDirectory: this.options.storageDirectory,
      transactionId: this.transactionId,
      schemaVersion: this.schemaVersion,
      hasRoot: this.started,
      ...(this.recoveredFrom ? { recoveredFrom: this.recoveredFrom } : {}),
      housekeepingActive: Boolean(this.housekeepingTimer),
      registeredTypes: this.serializer.types.entries().length,
      channelCount: this.layout.channelCount,
      lockStrategy: this.lockStrategy,
    };
  }

  /** Returns low-level operational counters for WAL, manifests, transaction logs, locks, and object records. */
  async operations(): Promise<StorageOperationsStatus> {
    const manifest = await this.reader.readManifest();
    const latestTransaction = await this.reader.readLatestTransactionRecord();
    const walFiles = await this.reader.readDirectoryIfExists(this.layout.walDirectory);
    const committedWal = await this.reader.readCommittedWalRecords();
    const publishedTransactionId = manifest?.transactionId ?? 0;
    const latestWalTransactionId = committedWal.reduce((latest, record) => Math.max(latest, record.transactionId), 0);
    const pendingWalCommits = committedWal.filter((record) => record.transactionId > publishedTransactionId).length;
    return {
      status: pendingWalCommits > 0 ? "recovery-pending" : "healthy",
      storageDirectory: this.options.storageDirectory,
      readOnly: this.options.readOnly ?? false,
      lockStrategy: this.lockStrategy,
      transactionLog: this.options.transactionLog ?? "full",
      lockTimeoutMs: this.options.lockTimeoutMs,
      ...(this.options.staleLockTimeoutMs ? { staleLockTimeoutMs: this.options.staleLockTimeoutMs } : {}),
      channelCount: this.layout.channelCount,
      ...(this.recoveredFrom ? { recoveredFrom: this.recoveredFrom } : {}),
      publishedTransactionId,
      schemaVersion: manifest?.schemaVersion ?? this.schemaVersion,
      latestJournalTransactionId: latestTransaction?.transactionId ?? 0,
      latestWalTransactionId,
      pendingWalCommits,
      walPrepareFiles: walFiles.filter((file) => file.endsWith(".prepare.json")).length,
      walCommitFiles: walFiles.filter((file) => file.endsWith(".commit.json")).length,
      objectCount: manifest?.objectIds.length ?? 0,
      ...(manifest?.latestTransactionHash ? { latestTransactionHash: manifest.latestTransactionHash } : {}),
    };
  }

  /** Calculates a production-safety profile from current operations and write configuration. */
  async safetyProfile(): Promise<StorageSafetyProfile> {
    return assessStorageSafety({
      operations: await this.operations(),
      writeProfile: this.writeOptions.profile,
      durability: this.writeOptions.durability,
      writeSnapshots: this.writeOptions.writeSnapshots,
      recoverCommittedWal: this.shouldRecoverCommittedWal,
      readCommittedWal: this.shouldReadCommittedWal,
      commitValidatorCount: this.options.commitValidators?.length ?? 0,
    });
  }

  /** Builds an operational health report from safety settings and optional full storage verification. */
  async health(options: StorageHealthOptions = {}): Promise<StorageHealthReport> {
    return buildStorageHealthReport({
      options,
      operations: await this.operations(),
      writeProfile: this.writeOptions.profile,
      durability: this.writeOptions.durability,
      writeSnapshots: this.writeOptions.writeSnapshots,
      recoverCommittedWal: this.shouldRecoverCommittedWal,
      readCommittedWal: this.shouldReadCommittedWal,
      commitValidatorCount: this.options.commitValidators?.length ?? 0,
      verify: () => this.verify(),
    });
  }

  /** Reports whether the persistent index is enabled, present, fresh, stale, or missing. */
  async indexStatus(): Promise<StorageIndexStatus> {
    this.assertStarted();
    const record = this.storageIndexRecord ?? await this.reader.readStorageIndex();
    this.storageIndexRecord = record;
    return storageIndexStatus({ options: this.indexOptions, record, transactionId: this.transactionId });
  }

  /** Rebuilds and persists all configured indexes from the currently loaded root graph. */
  async rebuildIndexes(): Promise<StorageIndexStatus> {
    this.assertStarted();
    this.assertWritable();
    return this.mutex.runExclusive(() => this.withWriteLock(async (lock) => {
      await lock.assertValid();
      const envelope = this.serializer.serialize(this.rootValue);
      await this.writer.writePersistentIndex(envelope, this.transactionId);
      await lock.assertValid();
      this.storageIndexRecord = this.indexRecordForEnvelope(envelope, this.transactionId);
      return this.indexStatus();
    }));
  }

  /** Compares the persisted index against a freshly built index for the current root graph. */
  async verifyIndexes(): Promise<StorageIndexVerificationResult> { this.assertStarted(); const envelope = this.serializer.serialize(this.rootValue);
    const expected = this.indexRecordForEnvelope(envelope, this.transactionId);
    const actual = this.storageIndexRecord ?? await this.reader.readStorageIndex();
    this.storageIndexRecord = actual;
    return verifyStorageIndexRecord({ expected, actual });
  }
  /** Rebuilds indexes to repair missing or stale persisted index data. */
  async repairIndexes(): Promise<StorageIndexStatus> { return this.rebuildIndexes(); }
  /** Returns the schema version currently loaded for this store. */
  currentSchemaVersion(): number {
    return this.schemaVersion;
  }

  /** Returns pending schema migration steps between the current and requested target version. */
  migrationStatus(targetVersion = this.targetSchemaVersion()): StorageMigrationStatus {
    const migrations = this.sortedSchemaMigrations();
    return {
      currentVersion: this.schemaVersion,
      targetVersion,
      latestAvailableVersion: migrations.at(-1)?.version ?? 0,
      pending: migrationPlan(this.schemaVersion, targetVersion, migrations),
    };
  }

  /** Runs schema migrations up or down inside committed transactions until the target version is reached. */
  async migrateTo(targetVersion = this.targetSchemaVersion()): Promise<StorageMigrationResult> {
    this.assertStarted();
    this.assertWritable();
    this.assertOutsideTransaction("migrateTo()");
    const fromVersion = this.schemaVersion;
    const plan = migrationPlan(fromVersion, targetVersion, this.sortedSchemaMigrations());
    const applied: StorageMigrationStepResult[] = [];
    for (const step of plan) {
      const migration = this.schemaMigrationFor(step.version);
      const result = await this.transaction(
        async ({ root }) => {
          this.schemaVersion = step.toVersion;
          const context = migrationContext(root, step);
          if (step.direction === "up") {
            await migration.up(context);
          } else {
            await migration.down(context);
          }
        },
        {
          mode: "pessimistic",
          metadata: {
            source: "graphvault-schema-migration",
            reason: `Schema migration ${step.direction} ${step.fromVersion} -> ${step.toVersion}`,
            tags: ["schema-migration"],
            schemaMigration: migrationMetadata(step),
          },
        },
      );
      applied.push({ ...step, metadata: result.metadata });
    }
    return {
      fromVersion,
      toVersion: this.schemaVersion,
      applied,
      skipped: applied.length === 0,
    };
  }

  /** Returns the active application root, throwing if the manager has not been started. */
  getRoot(): TRoot {
    return this.root;
  }

  /** Replaces the in-memory root object and rebinds lazy references without committing immediately. */
  setRoot(root: TRoot): void {
    this.rootValue = root;
    this.bindLazyRefs(this.rootValue);
  }

  /** Returns the active root object; kept for API compatibility with EmbeddedStorage-style access. */
  defaultRoot(): TRoot {
    return this.root;
  }

  /** Returns the custom root object supplied in options, if one was configured. */
  customRoot(): TRoot | undefined {
    return this.options.customRoot;
  }

  private async acquireLock(): Promise<void> {
    this.lockHandle = await this.target.acquireLock(this.layout.lockFile, this.options.lockTimeoutMs, this.lockOptions());
  }

  private get lockStrategy(): "startup" | "pessimistic" | "optimistic" {
    return this.options.lockStrategy ?? "startup";
  }

  private defaultTransactionMode(): TransactionLockMode {
    return this.lockStrategy === "optimistic" ? "optimistic" : "pessimistic";
  }

  private get inTransaction(): boolean {
    return this.transactionDepth > 0;
  }

  private async runInTransactionScope<T>(work: () => T | Promise<T>): Promise<T> {
    this.transactionDepth += 1;
    try {
      return await work();
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private assertOutsideTransaction(operation: string): void {
    if (this.inTransaction) {
      throw new TransactionScopeError(`${operation} cannot commit inside an active GraphVault transaction. Mutate the transaction root and let the outer transaction commit once.`);
    }
  }

  private startHousekeeping(): void {
    if (this.options.readOnly || this.options.housekeepingIntervalMs <= 0 || this.housekeepingTimer) {
      return;
    }
    this.housekeepingTimer = setInterval(() => {
      void this.collectGarbage().catch(() => {
        // Housekeeping is opportunistic; explicit calls report errors.
      });
    }, this.options.housekeepingIntervalMs);
    this.housekeepingTimer.unref();
  }

  private stopHousekeeping(): void {
    if (this.housekeepingTimer) {
      clearInterval(this.housekeepingTimer);
      this.housekeepingTimer = undefined;
    }
  }

  private async storeLocked(mode: StoreMode, targets: readonly unknown[], lock: StorageTargetLock, metadata?: TransactionMetadata): Promise<StoreMetadata> {
    this.bindLazyRefs(this.rootValue);
    await this.storeLoadedLazyRefs(this.rootValue);
    const envelope = this.serializer.serialize(this.rootValue);
    const objectIds = mode === "eager" ? Object.keys(envelope.nodes) : this.collectObjectIds(envelope, targets);
    return this.committer.commitEnvelope({
      envelope,
      baseTransactionId: this.transactionId,
      mode,
      objectIds,
      allObjectIds: sortedObjectIds(envelope),
      baseObjectVersions: this.persistedObjectVersions,
      targetCount: targets.length,
      lock,
      ...(metadata ? { metadata } : {}),
    });
  }

  private async pessimisticTransaction<T>(
    work: (context: GraphVaultTransactionContext<TRoot>) => T | Promise<T>,
    options: GraphVaultTransactionOptions<TRoot>,
  ): Promise<GraphVaultTransactionResult<T>> {
    return this.mutex.runExclusive(() =>
      this.withWriteLock(async (lock) => {
        await this.reloadLatestLocked();
        const baseTransactionId = this.transactionId;
        const rollback = this.cloneRoot();
        const rollbackSchemaVersion = this.schemaVersion;
        try {
          const value = await this.runInTransactionScope(() => work({ root: this.root, transactionId: baseTransactionId, attempt: 1 }));
          const commitMetadata = await this.storeLocked("eager", [options.storeTarget ? options.storeTarget(this.root) : this.root], lock, options.metadata);
          return { value, metadata: commitMetadata, baseTransactionId, attempts: 1, lockMode: "pessimistic" };
        } catch (error) {
          this.rootValue = rollback;
          this.schemaVersion = rollbackSchemaVersion;
          this.bindLazyRefs(this.rootValue);
          throw error;
        }
      }),
    );
  }

  private async optimisticTransaction<T>(
    work: (context: GraphVaultTransactionContext<TRoot>) => T | Promise<T>,
    options: GraphVaultTransactionOptions<TRoot>,
  ): Promise<GraphVaultTransactionResult<T>> {
    const maxRetries = options.maxRetries ?? this.options.optimisticMaxRetries ?? 3;
    const retryDelayMs = options.retryDelayMs ?? this.options.optimisticRetryDelayMs ?? 25;
    let lastConflict: unknown;
    for (let attempt = 1; attempt <= Math.max(1, maxRetries); attempt++) {
      const result = await this.mutex.runExclusive(async () => {
        await this.reloadLatestLocked();
        const baseTransactionId = this.transactionId;
        const rollback = this.cloneRoot();
        const rollbackSchemaVersion = this.schemaVersion;
        try {
          const value = await this.runInTransactionScope(() => work({ root: this.root, transactionId: baseTransactionId, attempt }));
          return await this.withWriteLock(async (lock) => {
            await this.assertNoExternalChangeLocked(baseTransactionId);
            const commitMetadata = await this.storeLocked("eager", [options.storeTarget ? options.storeTarget(this.root) : this.root], lock, options.metadata);
            return { ok: true as const, value, metadata: commitMetadata, baseTransactionId };
          });
        } catch (error) {
          this.rootValue = rollback;
          this.schemaVersion = rollbackSchemaVersion;
          this.bindLazyRefs(this.rootValue);
          if (error instanceof OptimisticLockError) {
            return { ok: false as const, error };
          }
          throw error;
        }
      });
      if (result.ok) {
        return { value: result.value, metadata: result.metadata, baseTransactionId: result.baseTransactionId, attempts: attempt, lockMode: "optimistic" };
      }
      lastConflict = result.error;
      if (attempt < Math.max(1, maxRetries)) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    throw lastConflict ?? new OptimisticLockError("Optimistic transaction failed because the store changed concurrently.");
  }

  private async writeWithConflictCheck<T>(work: (lock: StorageTargetLock) => Promise<T>): Promise<T> {
    return this.withWriteLock(async (lock) => {
      if (!this.lockHandle) {
        await this.assertNoExternalChangeLocked(this.transactionId);
      }
      return work(lock);
    });
  }

  private async withWriteLock<T>(work: (lock: StorageTargetLock) => Promise<T>): Promise<T> {
    if (this.lockHandle) {
      return work(this.lockHandle);
    }
    const handle = await this.target.acquireLock(this.layout.lockFile, this.options.lockTimeoutMs, this.lockOptions());
    try {
      return await work(handle);
    } finally {
      await handle.release();
    }
  }

  private async assertNoExternalChangeLocked(expectedTransactionId: number): Promise<void> {
    const currentTransactionId = await this.readCurrentTransactionId();
    if (currentTransactionId !== expectedTransactionId) {
      throw new OptimisticLockError(
        `Store changed concurrently. Expected transaction ${expectedTransactionId}, found ${currentTransactionId}.`,
      );
    }
  }

  private lockOptions(): StorageLockOptions {
    return typeof this.options.staleLockTimeoutMs === "number" ? { staleLockTimeoutMs: this.options.staleLockTimeoutMs } : {};
  }

  private get transactionLogEnabled(): boolean {
    return (this.options.transactionLog ?? "full") === "full";
  }

  private get shouldRecoverCommittedWal(): boolean {
    return this.options.recoverCommittedWal ?? this.transactionLogEnabled;
  }

  private get shouldReadCommittedWal(): boolean {
    return this.options.readCommittedWal ?? true;
  }

  private targetSchemaVersion(): number {
    return targetSchemaVersion(this.options.schemaVersion, this.options.schemaMigrations ?? []);
  }

  private sortedSchemaMigrations(): Array<StorageSchemaMigration<TRoot>> {
    return sortedSchemaMigrations(this.options.schemaMigrations ?? []);
  }

  private schemaMigrationFor(version: number): StorageSchemaMigration<TRoot> {
    const migration = this.sortedSchemaMigrations().find((candidate) => candidate.version === version);
    if (!migration) {
      throw new Error(`Missing schema migration for version ${version}.`);
    }
    return migration;
  }

  private async readCurrentTransactionId(): Promise<number> {
    const [manifest, latestTransaction] = await Promise.all([
      this.reader.readManifest(),
      this.reader.readLatestTransactionRecord(),
    ]);
    return Math.max(manifest?.transactionId ?? 0, latestTransaction?.transactionId ?? 0);
  }

  private async recoverCommittedWalLocked(lock: StorageTargetLock): Promise<void> {
    for (const commit of await this.reader.readCommittedWalRecords()) {
      const [manifest, latestTransaction] = await Promise.all([
        this.reader.readManifest(),
        this.reader.readLatestTransactionRecord(),
      ]);
      if ((manifest?.transactionId ?? 0) >= commit.transactionId && (latestTransaction?.transactionId ?? 0) >= commit.transactionId) {
        continue;
      }
      const prepare = await this.reader.readWalPrepareRecord(commit.prepareFile);
      if (!prepare || prepare.transactionId !== commit.transactionId) {
        continue;
      }
      await this.writer.writeObjectRecords(prepare.envelope, prepare.transactionId, prepare.objectIds);
      this.schemaVersion = prepare.schemaVersion ?? 0;
      if (this.writeOptions.writeSnapshots) {
        await this.writer.writeJson(join(this.layout.snapshotsDirectory, prepare.snapshotFile), prepare.envelope);
      }
      await this.committer.publishPreparedCommit({
        envelope: prepare.envelope,
        transactionId: prepare.transactionId,
        snapshotFile: prepare.snapshotFile,
        mode: prepare.mode,
        targetCount: prepare.targetCount,
        lock,
        objectVersions: new Map(Object.keys(prepare.envelope.nodes).map((objectId) => [objectId, prepare.transactionId])),
      });
      this.recoveredFrom = "wal";
    }
  }

  private async reloadLatestLocked(): Promise<void> {
    const loaded = await this.reader.loadExistingEnvelope({ includeWal: this.shouldReadCommittedWal });
    if (loaded) {
      const loadedRoot = this.serializer.deserialize<TRoot>(loaded.envelope);
      this.rootValue = this.fillCustomRoot(loadedRoot, loaded.envelope);
      this.transactionId = loaded.transactionId;
      this.recoveredFrom = loaded.source;
      this.replacePersistedObjectVersions(loaded.objectVersions);
      this.schemaVersion = loaded.schemaVersion;
      this.storageIndexRecord = await this.reader.readStorageIndex();
    } else {
      this.rootValue = this.options.rootFactory();
      this.transactionId = 0;
      this.recoveredFrom = "empty";
      this.schemaVersion = this.targetSchemaVersion();
      this.replacePersistedObjectVersions(new Map());
      this.storageIndexRecord = undefined;
    }
    this.bindLazyRefs(this.rootValue);
  }

  private cloneRoot(): TRoot {
    const clone = this.serializer.deserialize<TRoot>(this.serializer.serialize(this.rootValue));
    this.bindLazyRefs(clone);
    return clone;
  }

  private async storeEnvelopeLocked(
    envelope: SerializedEnvelope,
    mode: StoreMode,
    changedObjectIds: string[],
    lock: StorageTargetLock,
  ): Promise<StoreMetadata> {
    const objectIds = Array.from(new Set(changedObjectIds.length ? changedObjectIds : Object.keys(envelope.nodes))).sort((a, b) => Number(a) - Number(b));
    return this.committer.commitEnvelope({
      envelope,
      baseTransactionId: this.transactionId,
      mode,
      objectIds,
      allObjectIds: sortedObjectIds(envelope),
      baseObjectVersions: this.persistedObjectVersions,
      targetCount: objectIds.length,
      lock,
    });
  }

  private graphIndexForGvql(envelope: SerializedEnvelope, mutating: boolean): GvqlGraphIndex | undefined {
    if (this.indexOptions.mode === "off" || !this.storageIndexRecord || this.storageIndexRecord.transactionId !== this.transactionId) {
      return undefined;
    }
    if (mutating || this.indexOptions.consistency === "strict") {
      return isUsableStorageIndexRecord(this.storageIndexRecord, envelope, this.transactionId)
        ? graphIndexFromStorageRecord(envelope, this.storageIndexRecord)
        : undefined;
    }
    return graphIndexFromStorageRecord(envelope, this.storageIndexRecord);
  }

  private indexRecordForEnvelope(envelope: SerializedEnvelope, transactionId: number): StorageIndexRecord | undefined {
    return buildStorageIndexRecord(envelope, transactionId, this.indexOptions);
  }

  private collectObjectIds(envelope: SerializedEnvelope, targets: readonly unknown[]): string[] {
    return collectObjectIdsForTargets({
      envelope,
      targets,
      serializer: this.serializer,
      persistedObjectIds: this.persistedObjectIds,
      ...(this.options.eagerFieldEvaluator ? { eagerFieldEvaluator: this.options.eagerFieldEvaluator } : {}),
    });
  }

  private async repairObjectStoreFromEnvelope(envelope: SerializedEnvelope, transactionId: number): Promise<void> {
    const objectIds = Object.keys(envelope.nodes);
    await this.writer.writeObjectRecords(envelope, transactionId, objectIds);
    const objectVersions = new Map(objectIds.map((objectId) => [objectId, transactionId]));
    await this.writer.writeManifest(envelope, transactionId, objectVersions);
    await this.writer.writeParentIndex(envelope, transactionId);
    await this.writer.writePersistentIndex(envelope, transactionId);
    this.storageIndexRecord = this.indexRecordForEnvelope(envelope, transactionId);
    this.replacePersistedObjectVersions(objectVersions);
  }

  private replacePersistedObjectVersions(objectVersions: ReadonlyMap<string, number>): void {
    this.persistedObjectIds.clear();
    this.persistedObjectVersions.clear();
    for (const [objectId, transactionId] of objectVersions) {
      this.persistedObjectIds.add(objectId);
      this.persistedObjectVersions.set(objectId, transactionId);
    }
  }

  private async writeTypeDictionaryIfChanged(): Promise<void> {
    const entries = this.serializer.types.entries();
    const signature = JSON.stringify(entries);
    if (signature === this.typeDictionarySignature) {
      return;
    }
    await this.writer.writeTypeDictionary(entries);
    this.typeDictionarySignature = signature;
  }

  private async runCommitValidators(envelope: SerializedEnvelope, transactionId: number): Promise<void> {
    for (const validator of this.options.commitValidators ?? []) {
      await validator({ root: this.rootValue as TRoot, envelope, transactionId });
    }
  }

  private fillCustomRoot(loadedRoot: TRoot, envelope: SerializedEnvelope): TRoot {
    const customRoot = this.options.customRoot;
    if (!customRoot || typeof customRoot !== "object" || !loadedRoot || typeof loadedRoot !== "object") {
      return loadedRoot;
    }
    replaceObjectContents(customRoot, loadedRoot);
    if (envelope.root && typeof envelope.root === "object" && "$ref" in envelope.root) {
      this.serializer.objectIds.remember(envelope.root.$ref, customRoot);
    }
    return customRoot;
  }

  private bindLazyRefs(value: unknown, seen = new Set<object>()): void {
    bindStorageLazyRefs(value, { load: (key) => this.loadLazy(key), store: (key, item) => this.storeLazy(key, item) }, seen);
  }

  private async storeLoadedLazyRefs(value: unknown, seen = new Set<object>()): Promise<void> {
    await storeLoadedStorageLazyRefs(value, seen);
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new StorageNotStartedError("Storage manager has not been started.");
    }
  }

  private assertWritable(): void {
    if (this.options.readOnly) {
      throw new ReadonlyStorageError("Storage manager is read-only.");
    }
  }

}
