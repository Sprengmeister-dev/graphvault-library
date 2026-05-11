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
  SubtreeLoadOptions,
  SubtreeLoadResult,
  StorageTarget,
  StorageTargetLock,
  StoreMetadata,
  StoreMode,
  GraphVaultTransactionContext,
  GraphVaultTransactionOptions,
  GraphVaultTransactionResult,
  TransactionLockMode,
  TransactionMetadata,
  VerificationResult,
  MaintenanceResult,
  MaintenanceOptions,
} from "../core/types.js";
import type { GvqlExecutionOptions, GvqlResult } from "../gvql/gvql-types.js";

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

  constructor(options: StorageManagerOptions<TRoot>, serializer = new GraphSerializer(options.types ?? [])) {
    this.options = { lockTimeoutMs: 5_000, housekeepingIntervalMs: 0, ...options };
    this.writeOptions = resolveStorageWriteOptions(this.options);
    this.layout = new StorageLayout(this.options.storageDirectory, this.options.channelCount ?? 1);
    this.serializer = serializer;
    this.target = options.storageTarget ?? new LocalFilesystemTarget({ syncWrites: this.writeOptions.durability === "strict" });
    this.reader = new StorageReader(this.target, this.layout);
    this.writer = new StorageWriter(this.target, this.layout, this.writeOptions);
    this.committer = new StorageCommitter({
      target: this.target,
      layout: this.layout,
      writer: this.writer,
      writeOptions: this.writeOptions,
      transactionLogEnabled: () => this.transactionLogEnabled,
      validateCommit: (envelope, transactionId) => this.runCommitValidators(envelope, transactionId),
      beforePublish: () => this.writeTypeDictionaryIfChanged(),
      readLatestTransactionRecord: () => this.reader.readLatestTransactionRecord(),
      commitState: (transactionId, objectVersions) => {
        this.transactionId = transactionId;
        this.replacePersistedObjectVersions(objectVersions);
      },
    });
  }

  get root(): TRoot {
    if (!this.started) {
      throw new StorageNotStartedError("Storage manager has not been started.");
    }
    return this.rootValue as TRoot;
  }

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
      if (loaded.source === "snapshot" && !this.options.readOnly) {
        await this.repairObjectStoreFromEnvelope(loaded.envelope, loaded.transactionId);
      }
    } else {
      this.rootValue = this.options.rootFactory();
      this.recoveredFrom = "empty";
    }
    this.bindLazyRefs(this.rootValue);
    this.started = true;
    this.startHousekeeping();
    return this;
  }

  async shutdown(): Promise<void> {
    this.stopHousekeeping();
    if (this.lockHandle) {
      await this.lockHandle.release();
      this.lockHandle = undefined;
    }
    this.started = false;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.shutdown();
  }

  async storeRoot(): Promise<StoreMetadata> {
    this.assertStarted();
    this.assertWritable();
    this.assertOutsideTransaction("storeRoot()");
    return this.mutex.runExclusive(() => this.writeWithConflictCheck((lock) => this.storeLocked("eager", [this.root], lock)));
  }

  async store(_modifiedObject: unknown): Promise<StoreMetadata> {
    this.assertStarted();
    this.assertWritable();
    this.assertOutsideTransaction("store()");
    const mode: StoreMode = _modifiedObject === this.rootValue ? "eager" : "standard";
    return this.mutex.runExclusive(() => this.writeWithConflictCheck((lock) => this.storeLocked(mode, [_modifiedObject], lock)));
  }

  async storeAll(instances: Iterable<unknown>): Promise<StoreMetadata>;
  async storeAll(...instances: unknown[]): Promise<StoreMetadata>;
  async storeAll(firstOrInstances: Iterable<unknown> | unknown, ...rest: unknown[]): Promise<StoreMetadata> {
    this.assertStarted();
    this.assertWritable();
    this.assertOutsideTransaction("storeAll()");
    const targets = rest.length > 0 || !isIterable(firstOrInstances) ? [firstOrInstances, ...rest] : Array.from(firstOrInstances);
    return this.mutex.runExclusive(() => this.writeWithConflictCheck((lock) => this.storeLocked("standard", targets, lock)));
  }

  createStorer(): Storer {
    return new Storer(this, "standard");
  }

  createLazyStorer(): Storer {
    return new Storer(this, "lazy");
  }

  createEagerStorer(): Storer {
    return new Storer(this, "eager");
  }

  async commitStorer(mode: StoreMode, targets: readonly unknown[]): Promise<StoreMetadata> {
    this.assertStarted();
    this.assertWritable();
    this.assertOutsideTransaction("storer.commit()");
    return this.mutex.runExclusive(() => this.writeWithConflictCheck((lock) => this.storeLocked(mode, targets, lock)));
  }

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

  async transaction<T>(
    work: (context: GraphVaultTransactionContext<TRoot>) => T | Promise<T>,
    options: GraphVaultTransactionOptions<TRoot> = {},
  ): Promise<GraphVaultTransactionResult<T>> {
    this.assertStarted();
    this.assertWritable();
    const mode = options.mode ?? this.defaultTransactionMode();
    return mode === "optimistic" ? this.optimisticTransaction(work, options) : this.pessimisticTransaction(work, options);
  }

  async createLazyRef<T>(key: string, initialValue: T): Promise<LazyRef<T>> {
    this.assertStarted();
    this.assertWritable();
    this.assertOutsideTransaction("createLazyRef()");
    const ref = new LazyRef<T>(key, initialValue);
    ref.bind((lazyKey) => this.loadLazy<T>(lazyKey), (lazyKey, value) => this.storeLazy(lazyKey, value));
    await ref.store();
    return ref;
  }

  async loadLazy<T>(key: string): Promise<T> {
    const content = await this.target.readText(join(this.layout.lazyDirectory, `${encodeURIComponent(key)}.json`));
    return this.serializer.deserialize<T>(JSON.parse(content) as SerializedEnvelope);
  }

  async storeLazy<T>(key: string, value: T): Promise<void> {
    this.assertStarted();
    this.assertWritable();
    this.assertOutsideTransaction("storeLazy()");
    await this.writer.writeJson(join(this.layout.lazyDirectory, `${encodeURIComponent(key)}.json`), this.serializer.serialize(value));
  }

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

  async collectGarbage(): Promise<GarbageCollectionResult> {
    this.assertStarted();
    this.assertWritable();
    return this.mutex.runExclusive(() => this.collectGarbageLocked());
  }

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

  async verify(): Promise<VerificationResult> {
    return verifyStorage({
      target: this.target,
      lazyDirectory: this.layout.lazyDirectory,
      walDirectory: this.layout.walDirectory,
      readManifest: () => this.reader.readManifest(),
      readLatestTransactionRecord: () => this.reader.readLatestTransactionRecord(),
      readTransactionRecords: () => this.reader.readTransactionRecords(),
      readObjectRecord: (objectId, transactionId) => this.reader.readObjectRecord(objectId, transactionId),
      readSnapshotEnvelope: async (snapshotFile) => JSON.parse(await this.target.readText(join(this.layout.snapshotsDirectory, snapshotFile))) as SerializedEnvelope,
    });
  }

  async maintain(options: MaintenanceOptions = {}): Promise<MaintenanceResult> {
    const garbageCollection = await this.collectGarbage();
    const compaction = await this.compact(options.keepSnapshots ?? 2);
    if (options.verify === false) {
      return { garbageCollection, compaction };
    }
    return { garbageCollection, compaction, verification: await this.verify() };
  }

  async issueFullGarbageCollection(): Promise<GarbageCollectionResult> {
    return this.collectGarbage();
  }

  async issueGarbageCollection(_timeBudgetMs?: number): Promise<GarbageCollectionResult> {
    return this.collectGarbage();
  }

  async issueFullFileCheck(): Promise<VerificationResult> {
    return this.verify();
  }

  async issueFileCheck(_timeBudgetMs?: number): Promise<VerificationResult> {
    return this.verify();
  }

  async issueFullMaintenance(options: MaintenanceOptions = {}): Promise<MaintenanceResult> {
    return this.maintain({ keepSnapshots: 1, ...options });
  }

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
        const result = executeGvqlStatement(envelope, statement, {
          ...options,
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
          const result = executeGvqlStatement(envelope, statement, {
            ...options,
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

  async previewGvql(query: string, options: Omit<GvqlExecutionOptions, "dryRun"> = {}): Promise<GvqlResult> {
    return this.gvql(query, { ...options, dryRun: true });
  }

  async loadSubtree(options?: SubtreeLoadOptions): Promise<SubtreeLoadResult>;
  async loadSubtree(rootObjectId: string, options?: SubtreeLoadOptions): Promise<SubtreeLoadResult>;
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
    const manifest = await this.reader.readManifest();
    if (!manifest) {
      return {
        keptObjects: 0,
        removedObjects: 0,
        keptBinaryObjects: 0,
        removedBinaryObjects: 0,
        keptLazyFiles: 0,
        removedLazyFiles: 0,
      };
    }

    const liveJsonRecords = liveObjectRecordFiles(manifest, "json");
    const liveBinaryRecords = liveObjectRecordFiles(manifest, "bin");
    const liveLazyFiles = new Set<string>();
    const envelope = await this.reader.envelopeFromManifest(manifest);
    for (const node of Object.values(envelope.nodes)) {
      if (node.kind === "lazy") {
        liveLazyFiles.add(`${encodeURIComponent(node.key)}.json`);
      }
    }

    let keptObjects = 0;
    let removedObjects = 0;
    for (const directory of this.layout.objectRecordDirectories("json")) {
      for (const file of await this.reader.readDirectoryIfExists(directory)) {
        if (!file.endsWith(".json")) {
          continue;
        }
        if (liveJsonRecords.has(file)) {
          keptObjects++;
        } else {
          await this.target.remove(join(directory, file));
          removedObjects++;
        }
      }
    }

    let keptBinaryObjects = 0;
    let removedBinaryObjects = 0;
    for (const directory of this.layout.objectRecordDirectories("binary")) {
      for (const file of await this.reader.readDirectoryIfExists(directory)) {
        if (!file.endsWith(".bin")) {
          continue;
        }
        if (liveBinaryRecords.has(file)) {
          keptBinaryObjects++;
        } else {
          await this.target.remove(join(directory, file));
          removedBinaryObjects++;
        }
      }
    }

    let keptLazyFiles = 0;
    let removedLazyFiles = 0;
    for (const file of await this.reader.readDirectoryIfExists(this.layout.lazyDirectory)) {
      if (!file.endsWith(".json")) {
        continue;
      }
      if (liveLazyFiles.has(file)) {
        keptLazyFiles++;
      } else {
        await this.target.remove(join(this.layout.lazyDirectory, file));
        removedLazyFiles++;
      }
    }

    return { keptObjects, removedObjects, keptBinaryObjects, removedBinaryObjects, keptLazyFiles, removedLazyFiles };
  }

  status(): StorageStatus {
    return {
      started: this.started,
      readOnly: this.options.readOnly ?? false,
      storageDirectory: this.options.storageDirectory,
      transactionId: this.transactionId,
      hasRoot: this.started,
      ...(this.recoveredFrom ? { recoveredFrom: this.recoveredFrom } : {}),
      housekeepingActive: Boolean(this.housekeepingTimer),
      registeredTypes: this.serializer.types.entries().length,
      channelCount: this.layout.channelCount,
      lockStrategy: this.lockStrategy,
    };
  }

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
      latestJournalTransactionId: latestTransaction?.transactionId ?? 0,
      latestWalTransactionId,
      pendingWalCommits,
      walPrepareFiles: walFiles.filter((file) => file.endsWith(".prepare.json")).length,
      walCommitFiles: walFiles.filter((file) => file.endsWith(".commit.json")).length,
      objectCount: manifest?.objectIds.length ?? 0,
      ...(manifest?.latestTransactionHash ? { latestTransactionHash: manifest.latestTransactionHash } : {}),
    };
  }

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

  getRoot(): TRoot {
    return this.root;
  }

  setRoot(root: TRoot): void {
    this.rootValue = root;
    this.bindLazyRefs(this.rootValue);
  }

  defaultRoot(): TRoot {
    return this.root;
  }

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
        try {
          const value = await this.runInTransactionScope(() => work({ root: this.root, transactionId: baseTransactionId, attempt: 1 }));
          const commitMetadata = await this.storeLocked("eager", [options.storeTarget ? options.storeTarget(this.root) : this.root], lock, options.metadata);
          return { value, metadata: commitMetadata, baseTransactionId, attempts: 1, lockMode: "pessimistic" };
        } catch (error) {
          this.rootValue = rollback;
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
        try {
          const value = await this.runInTransactionScope(() => work({ root: this.root, transactionId: baseTransactionId, attempt }));
          return await this.withWriteLock(async (lock) => {
            await this.assertNoExternalChangeLocked(baseTransactionId);
            const commitMetadata = await this.storeLocked("eager", [options.storeTarget ? options.storeTarget(this.root) : this.root], lock, options.metadata);
            return { ok: true as const, value, metadata: commitMetadata, baseTransactionId };
          });
        } catch (error) {
          this.rootValue = rollback;
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
    } else {
      this.rootValue = this.options.rootFactory();
      this.transactionId = 0;
      this.recoveredFrom = "empty";
      this.replacePersistedObjectVersions(new Map());
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

  private collectObjectIds(envelope: SerializedEnvelope, targets: readonly unknown[]): string[] {
    const requested = new Set<string>();
    const seen = new Set<unknown>();

    const visitValue = (value: unknown, force = false): void => {
      if (!value || typeof value !== "object" || seen.has(value)) {
        return;
      }
      seen.add(value);
      const id = this.serializer.objectIds.idFor(value);
      if (envelope.nodes[id]) {
        if (force || !this.persistedObjectIds.has(id)) {
          requested.add(id);
        }
      }
      if (value instanceof LazyRef) {
        return;
      }
      if (value instanceof Map) {
        for (const [key, item] of value) {
          visitValue(key);
          visitValue(item);
        }
        return;
      }
      if (value instanceof Set || Array.isArray(value)) {
        for (const item of value) {
          visitValue(item);
        }
        return;
      }
      const entries = Object.entries(value);
      for (const [fieldName, item] of entries) {
        visitValue(item, Boolean(this.options.eagerFieldEvaluator?.({ owner: value, fieldName, value: item })));
      }
    };

    for (const target of targets) {
      visitValue(target, true);
    }
    if (requested.size === 0 && envelope.root && typeof envelope.root === "object" && "$ref" in envelope.root) {
      requested.add(envelope.root.$ref);
    }
    return Array.from(requested).sort((a, b) => Number(a) - Number(b));
  }

  private async repairObjectStoreFromEnvelope(envelope: SerializedEnvelope, transactionId: number): Promise<void> {
    const objectIds = Object.keys(envelope.nodes);
    await this.writer.writeObjectRecords(envelope, transactionId, objectIds);
    const objectVersions = new Map(objectIds.map((objectId) => [objectId, transactionId]));
    await this.writer.writeManifest(envelope, transactionId, objectVersions);
    await this.writer.writeParentIndex(envelope, transactionId);
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
    if (!value || typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (value instanceof LazyRef) {
      value.bind((key) => this.loadLazy(key), (key, item) => this.storeLazy(key, item));
      return;
    }
    if (value instanceof Map) {
      for (const [key, item] of value) {
        this.bindLazyRefs(key, seen);
        this.bindLazyRefs(item, seen);
      }
      return;
    }
    if (value instanceof Set || Array.isArray(value)) {
      for (const item of value) {
        this.bindLazyRefs(item, seen);
      }
      return;
    }
    for (const item of Object.values(value)) {
      this.bindLazyRefs(item, seen);
    }
  }

  private async storeLoadedLazyRefs(value: unknown, seen = new Set<object>()): Promise<void> {
    if (!value || typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (value instanceof LazyRef) {
      if (value.isLoaded()) {
        await value.store();
      }
      return;
    }
    if (value instanceof Map) {
      for (const [key, item] of value) {
        await this.storeLoadedLazyRefs(key, seen);
        await this.storeLoadedLazyRefs(item, seen);
      }
      return;
    }
    if (value instanceof Set || Array.isArray(value)) {
      for (const item of value) {
        await this.storeLoadedLazyRefs(item, seen);
      }
      return;
    }
    for (const item of Object.values(value)) {
      await this.storeLoadedLazyRefs(item, seen);
    }
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

function isIterable(value: unknown): value is Iterable<unknown> {
  return Boolean(value) && typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function";
}

function replaceObjectContents(target: object, source: object): void {
  if (Array.isArray(target) && Array.isArray(source)) {
    target.splice(0, target.length, ...source);
    return;
  }
  if (target instanceof Map && source instanceof Map) {
    target.clear();
    for (const [key, value] of source) {
      target.set(key, value);
    }
    return;
  }
  if (target instanceof Set && source instanceof Set) {
    target.clear();
    for (const value of source) {
      target.add(value);
    }
    return;
  }
  for (const key of Object.keys(target)) {
    delete (target as Record<string, unknown>)[key];
  }
  Object.assign(target, source);
}

function liveObjectRecordFiles(manifest: { objectIds: string[]; transactionId: number; objectVersions?: Record<string, number> }, extension: "json" | "bin"): Set<string> {
  const files = new Set<string>();
  for (const objectId of manifest.objectIds) {
    files.add(`${objectId}.${extension}`);
    files.add(`${objectId}.${manifest.objectVersions?.[objectId] ?? manifest.transactionId}.${extension}`);
  }
  return files;
}
