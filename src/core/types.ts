export type ClassConstructor<T = object> = new (...args: never[]) => T;

/** Describes the public TypeRegistration contract. */
export interface TypeRegistration<T extends object = object> {
  name: string;
  ctor: ClassConstructor<T>;
  version?: number;
  create?: () => T;
  serialize?: (value: T) => Record<string, unknown>;
  hydrate?: (target: T, state: Record<string, unknown>, fromVersion: number) => void;
  migrate?: (state: Record<string, unknown>, fromVersion: number) => Record<string, unknown>;
}

/** Describes the public SerializedEnvelope contract. */
export interface SerializedEnvelope {
  format: "graphvault";
  version: 1;
  createdAt: string;
  root: EncodedValue;
  nodes: Record<string, EncodedNode>;
}

/** Describes the public ObjectRecord contract. */
export interface ObjectRecord {
  format: "graphvault-object";
  version: 1;
  objectId: string;
  transactionId: number;
  storedAt: string;
  node: EncodedNode;
}

/** Describes the public StorageManifest contract. */
export interface StorageManifest {
  format: "graphvault-manifest";
  version: 1;
  transactionId: number;
  createdAt: string;
  root: EncodedValue;
  objectIds: string[];
  objectVersions?: Record<string, number>;
  latestTransactionHash?: string;
  schemaVersion?: number;
}

/** Describes the public TransactionRecord contract. */
export interface TransactionRecord {
  format: "graphvault-transaction";
  version: 1;
  transactionId: number;
  committedAt: string;
  snapshotFile: string;
  objectIds: string[];
  mode: StoreMode;
  targetCount: number;
  metadata?: TransactionMetadata;
  envelopeHash?: string;
  previousHash?: string;
  transactionHash?: string;
  schemaVersion?: number;
}

/** Describes the public TransactionMetadata contract. */
export interface TransactionMetadata {
  actor?: string;
  reason?: string;
  source?: string;
  traceId?: string;
  tags?: string[];
  attributes?: Record<string, string | number | boolean | null>;
  schemaMigration?: SchemaMigrationMetadata;
}

/** Describes the public SchemaMigrationMetadata contract. */
export interface SchemaMigrationMetadata {
  version: number;
  name?: string;
  direction: StorageMigrationDirection;
  fromVersion: number;
  toVersion: number;
}

/** Describes the public WalPrepareRecord contract. */
export interface WalPrepareRecord {
  format: "graphvault-wal";
  version: 1;
  status: "prepared";
  transactionId: number;
  preparedAt: string;
  snapshotFile: string;
  objectIds: string[];
  mode: StoreMode;
  targetCount: number;
  envelope: SerializedEnvelope;
  schemaVersion?: number;
}

/** Describes the public WalCommitRecord contract. */
export interface WalCommitRecord {
  format: "graphvault-wal";
  version: 1;
  status: "committed";
  transactionId: number;
  committedAt: string;
  prepareFile: string;
  schemaVersion?: number;
}

export type WalRecord = WalPrepareRecord | WalCommitRecord;

/** Describes the public TypeDictionary contract. */
export interface TypeDictionary {
  format: "graphvault-type-dictionary";
  version: 1;
  types: TypeDictionaryEntry[];
}

/** Describes the public ParentIndexRecord contract. */
export interface ParentIndexRecord {
  format: "graphvault-parent-index";
  version: 1;
  transactionId: number;
  rootObjectId?: string;
  parents: Record<string, ParentReference[]>;
}

/** Describes the public ParentReference contract. */
export interface ParentReference {
  parentObjectId: string;
  path: string;
}

export type StorageIndexMode = "off" | "auto" | "configured";
export type StorageIndexConsistency = "strict" | "committed";

/** Describes the public StorageIndexDefinition contract. */
export interface StorageIndexDefinition {
  type?: string;
  path: string;
}

export type StorageIndexConditionOperator = "=" | "!=" | "IN" | "IS NULL" | "IS NOT NULL";

/** Describes the public StorageIndexCondition contract. */
export interface StorageIndexCondition {
  type?: string;
  path: string;
  operator?: StorageIndexConditionOperator;
  value?: unknown;
  values?: unknown[];
}

/** Describes the public StorageCompositeIndexDefinition contract. */
export interface StorageCompositeIndexDefinition {
  name?: string;
  type?: string;
  paths: string[];
  unique?: boolean;
  sparse?: boolean;
  partial?: StorageIndexCondition;
}

/** Describes the public StorageRangeIndexDefinition contract. */
export interface StorageRangeIndexDefinition extends StorageIndexDefinition {
  name?: string;
  sparse?: boolean;
  partial?: StorageIndexCondition;
}

/** Describes the public StorageTextIndexDefinition contract. */
export interface StorageTextIndexDefinition extends StorageIndexDefinition {
  name?: string;
  caseSensitive?: boolean;
  minGram?: number;
  maxGram?: number;
  sparse?: boolean;
  partial?: StorageIndexCondition;
}

/** Describes the public StorageFullTextIndexDefinition contract. */
export interface StorageFullTextIndexDefinition extends StorageIndexDefinition {
  name?: string;
  caseSensitive?: boolean;
  sparse?: boolean;
  partial?: StorageIndexCondition;
}

/** Describes the public StorageUniqueIndexDefinition contract. */
export interface StorageUniqueIndexDefinition {
  name?: string;
  type?: string;
  path?: string;
  paths?: string[];
  sparse?: boolean;
  partial?: StorageIndexCondition;
}

/** Describes the public StorageExpressionIndexDefinition contract. */
export interface StorageExpressionIndexDefinition {
  name?: string;
  type?: string;
  expression: {
    fn: "lower" | "upper" | "trim" | "length";
    path: string;
  };
  unique?: boolean;
  sparse?: boolean;
  partial?: StorageIndexCondition;
}

/** Describes the public StorageIndexOptions contract. */
export interface StorageIndexOptions {
  mode?: StorageIndexMode;
  consistency?: StorageIndexConsistency;
  properties?: Array<string | StorageIndexDefinition>;
  composites?: StorageCompositeIndexDefinition[];
  ranges?: Array<string | StorageRangeIndexDefinition>;
  text?: Array<string | StorageTextIndexDefinition>;
  fullText?: Array<string | StorageFullTextIndexDefinition>;
  unique?: Array<string | StorageUniqueIndexDefinition>;
  expressions?: StorageExpressionIndexDefinition[];
}

/** Describes the public StorageIndexRecord contract. */
export interface StorageIndexRecord {
  format: "graphvault-index";
  version: 2;
  transactionId: number;
  createdAt: string;
  envelopeHash: string;
  nodeCount: number;
  mode: Exclude<StorageIndexMode, "off">;
  indexedProperties: StorageIndexDefinition[];
  byType: Record<string, string[]>;
  byProperty: Record<string, string[]>;
  outgoing: Record<string, StorageIndexEdge[]>;
  incoming: Record<string, StorageIndexEdge[]>;
  advanced?: StorageAdvancedIndexRecord;
}

/** Describes the public StorageIndexEdge contract. */
export interface StorageIndexEdge {
  from: string;
  to: string;
  path: string;
  label: string;
}

/** Describes the public StorageAdvancedIndexRecord contract. */
export interface StorageAdvancedIndexRecord {
  definitions: StorageAdvancedIndexDefinitionRecord[];
  composite: Record<string, Record<string, string[]>>;
  range: Record<string, StorageRangeIndexEntry[]>;
  text: Record<string, Record<string, string[]>>;
  fullText: Record<string, Record<string, string[]>>;
  expression: Record<string, Record<string, string[]>>;
  unique: Record<string, Record<string, string>>;
  statistics: Record<string, StorageIndexStatistics>;
}

/** Describes the public StorageAdvancedIndexDefinitionRecord contract. */
export interface StorageAdvancedIndexDefinitionRecord {
  name: string;
  kind: "composite" | "range" | "text" | "fullText" | "unique" | "expression";
  type?: string;
  path?: string;
  paths?: string[];
  expression?: StorageExpressionIndexDefinition["expression"];
  unique?: boolean;
  sparse?: boolean;
  caseSensitive?: boolean;
  minGram?: number;
  maxGram?: number;
  partial?: StorageIndexCondition;
}

/** Describes the public StorageRangeIndexEntry contract. */
export interface StorageRangeIndexEntry {
  value: string;
  raw: unknown;
  objectIds: string[];
}

/** Describes the public StorageIndexStatistics contract. */
export interface StorageIndexStatistics {
  entries: number;
  keys: number;
  maxBucketSize: number;
  averageBucketSize: number;
  selectivity: number;
}

/** Describes the public StorageIndexStatus contract. */
export interface StorageIndexStatus {
  enabled: boolean;
  mode: StorageIndexMode;
  consistency: StorageIndexConsistency;
  transactionId?: number;
  nodeCount: number;
  propertyKeys: number;
  edgeCount: number;
  advancedIndexes?: number;
  compositeKeys?: number;
  rangeKeys?: number;
  textTerms?: number;
  fullTextTerms?: number;
  expressionKeys?: number;
  uniqueKeys?: number;
  source: "memory" | "storage" | "missing" | "stale" | "disabled";
}

/** Describes the public StorageIndexVerificationResult contract. */
export interface StorageIndexVerificationResult {
  ok: boolean;
  checkedIndexes: number;
  errors: string[];
  warnings: string[];
}

/** Describes the public SubtreeLoadOptions contract. */
export interface SubtreeLoadOptions {
  depth?: number;
  rootObjectId?: string;
}

/** Describes the public SubtreeReference contract. */
export interface SubtreeReference {
  fromObjectId: string;
  toObjectId: string;
  path: string;
  depth: number;
}

/** Describes the public SubtreeLoadResult contract. */
export interface SubtreeLoadResult {
  envelope: SerializedEnvelope;
  transactionId: number;
  depth: number;
  complete: boolean;
  objectIds: string[];
  truncatedReferences: SubtreeReference[];
  rootObjectId?: string;
}

/** Describes the public TypeDictionaryEntry contract. */
export interface TypeDictionaryEntry {
  name: string;
  version: number;
  /** Creates a TypeDictionaryEntry instance. */
  constructorName: string;
}

export type EncodedValue =
  | null
  | string
  | number
  | boolean
  | { $type: "undefined" }
  | { $type: "number"; value: "NaN" | "Infinity" | "-Infinity" | "-0" }
  | { $type: "bigint"; value: string }
  | { $type: "symbol"; global?: true; key: string | null }
  | { $type: "date"; value: string }
  | { $type: "buffer"; value: string }
  | { $type: "regexp"; source: string; flags: string }
  | { $type: "url"; value: string }
  | { $type: "urlsearchparams"; value: string }
  | { $type: "error"; name: string; message: string; stack?: string; cause?: EncodedValue; errors?: EncodedValue[] }
  | { $type: "arraybuffer"; value: string }
  | { $type: "sharedarraybuffer"; value: string }
  | { $type: "dataview"; value: string }
  | { $type: "typedarray"; ctor: TypedArrayName; value: string }
  | { $ref: string };

export type TypedArrayName =
  | "Int8Array"
  | "Uint8Array"
  | "Uint8ClampedArray"
  | "Int16Array"
  | "Uint16Array"
  | "Int32Array"
  | "Uint32Array"
  | "Float32Array"
  | "Float64Array"
  | "BigInt64Array"
  | "BigUint64Array";

export type EncodedNode =
  | { kind: "array"; items: EncodedValue[] }
  | { kind: "map"; entries: Array<[EncodedValue, EncodedValue]> }
  | { kind: "set"; items: EncodedValue[] }
  | { kind: "object"; type?: string; version?: number; props: Record<string, EncodedValue>; symbolProps?: Array<[EncodedValue, EncodedValue]> }
  | { kind: "lazy"; key: string };

/** Describes the public StorageManagerOptions contract. */
export interface StorageManagerOptions<TRoot = unknown> {
  storageDirectory: string;
  rootFactory: () => TRoot;
  customRoot?: TRoot;
  types?: Array<TypeRegistration<any>>;
  readOnly?: boolean;
  lockTimeoutMs?: number;
  staleLockTimeoutMs?: number;
  housekeepingIntervalMs?: number;
  eagerFieldEvaluator?: EagerFieldEvaluator;
  storageTarget?: StorageTarget;
  channelCount?: number;
  writeProfile?: StorageWriteProfile;
  objectRecordFormat?: ObjectRecordWriteFormat;
  objectRecordWriteConcurrency?: number;
  prettyJson?: boolean;
  writeDurability?: StorageWriteDurability;
  writeSnapshots?: boolean;
  lockStrategy?: StorageLockStrategy;
  optimisticMaxRetries?: number;
  optimisticRetryDelayMs?: number;
  commitValidators?: Array<StorageCommitValidator<TRoot>>;
  transactionLog?: StorageTransactionLogMode;
  recoverCommittedWal?: boolean;
  readCommittedWal?: boolean;
  schemaVersion?: number;
  schemaMigrations?: Array<StorageSchemaMigration<TRoot>>;
  migrateOnStart?: boolean;
  indexes?: boolean | StorageIndexOptions;
}

export type StorageCommitValidator<TRoot = unknown> = (context: {
  root: TRoot;
  envelope: SerializedEnvelope;
  transactionId: number;
}) => void | Promise<void>;

/** Describes the public StorageTarget contract. */
export interface StorageTarget {
  /** Runs StorageTarget.ensureDirectory. */
  ensureDirectory(path: string): Promise<void>;
  /** Runs StorageTarget.exists. */
  exists(path: string): Promise<boolean>;
  /** Runs StorageTarget.list. */
  list(path: string): Promise<string[]>;
  /** Runs StorageTarget.readText. */
  readText(path: string): Promise<string>;
  /** Runs StorageTarget.readBuffer. */
  readBuffer(path: string): Promise<Buffer>;
  /** Runs StorageTarget.writeTextAtomic. */
  writeTextAtomic(path: string, value: string): Promise<void>;
  /** Runs StorageTarget.writeBufferAtomic. */
  writeBufferAtomic(path: string, value: Buffer): Promise<void>;
  /** Runs StorageTarget.appendText. */
  appendText(path: string, value: string): Promise<void>;
  /** Runs StorageTarget.remove. */
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** Runs StorageTarget.acquireLock. */
  acquireLock(path: string, timeoutMs: number, options?: StorageLockOptions): Promise<StorageTargetLock>;
}

/** Describes the public StorageLockOptions contract. */
export interface StorageLockOptions {
  staleLockTimeoutMs?: number;
}

/** Describes the public StorageTargetLock contract. */
export interface StorageTargetLock {
  fencingToken: number;
  /** Runs StorageTargetLock.assertValid. */
  assertValid(): Promise<void>;
  /** Runs StorageTargetLock.release. */
  release(): Promise<void>;
}

/** Describes the public StoreMetadata contract. */
export interface StoreMetadata {
  transactionId: number;
  storedAt: Date;
  snapshotFile: string;
  journalFile: string;
  mode: StoreMode;
  objectCount: number;
  objectIds: string[];
  metadata?: TransactionMetadata;
}

/** Describes the public GraphVaultTransactionContext contract. */
export interface GraphVaultTransactionContext<TRoot = unknown> {
  root: TRoot;
  transactionId: number;
  attempt: number;
}

/** Describes the public GraphVaultTransactionOptions contract. */
export interface GraphVaultTransactionOptions<TRoot = unknown> {
  mode?: TransactionLockMode;
  maxRetries?: number;
  retryDelayMs?: number;
  storeTarget?: (root: TRoot) => unknown;
  metadata?: TransactionMetadata;
}

/** Describes the public GraphVaultTransactionResult contract. */
export interface GraphVaultTransactionResult<T = unknown> {
  value: T;
  metadata: StoreMetadata;
  baseTransactionId: number;
  attempts: number;
  lockMode: TransactionLockMode;
}

export type StorageMigrationDirection = "up" | "down";

/** Describes the public StorageSchemaMigrationContext contract. */
export interface StorageSchemaMigrationContext<TRoot = unknown> {
  root: TRoot;
  direction: StorageMigrationDirection;
  fromVersion: number;
  toVersion: number;
  version: number;
  name?: string;
}

/** Describes the public StorageSchemaMigration contract. */
export interface StorageSchemaMigration<TRoot = unknown> {
  version: number;
  name?: string;
  up: (context: StorageSchemaMigrationContext<TRoot>) => void | Promise<void>;
  down: (context: StorageSchemaMigrationContext<TRoot>) => void | Promise<void>;
}

/** Describes the public StorageMigrationStatus contract. */
export interface StorageMigrationStatus {
  currentVersion: number;
  targetVersion: number;
  latestAvailableVersion: number;
  pending: StorageMigrationPlanStep[];
}

/** Describes the public StorageMigrationPlanStep contract. */
export interface StorageMigrationPlanStep {
  version: number;
  name?: string;
  direction: StorageMigrationDirection;
  fromVersion: number;
  toVersion: number;
}

/** Describes the public StorageMigrationStepResult contract. */
export interface StorageMigrationStepResult extends StorageMigrationPlanStep {
  metadata: StoreMetadata;
}

/** Describes the public StorageMigrationResult contract. */
export interface StorageMigrationResult {
  fromVersion: number;
  toVersion: number;
  applied: StorageMigrationStepResult[];
  skipped: boolean;
}

/** Describes the public StorageStatus contract. */
export interface StorageStatus {
  started: boolean;
  readOnly: boolean;
  storageDirectory: string;
  transactionId: number;
  schemaVersion: number;
  hasRoot: boolean;
  recoveredFrom?: "manifest" | "snapshot" | "wal" | "empty";
  housekeepingActive: boolean;
  registeredTypes: number;
  channelCount: number;
  lockStrategy: StorageLockStrategy;
}

/** Describes the public StorageOperationsStatus contract. */
export interface StorageOperationsStatus {
  status: "healthy" | "recovery-pending";
  storageDirectory: string;
  readOnly: boolean;
  lockStrategy: StorageLockStrategy;
  transactionLog: StorageTransactionLogMode;
  lockTimeoutMs: number;
  staleLockTimeoutMs?: number;
  channelCount: number;
  recoveredFrom?: "manifest" | "snapshot" | "wal" | "empty";
  publishedTransactionId: number;
  schemaVersion: number;
  latestJournalTransactionId: number;
  latestWalTransactionId: number;
  pendingWalCommits: number;
  walPrepareFiles: number;
  walCommitFiles: number;
  objectCount: number;
  latestTransactionHash?: string;
}

export type StorageSafetyStatus = "production-ready" | "warning" | "unsafe";

export type StorageSafetySeverity = "info" | "warning" | "critical";

/** Describes the public StorageSafetyIssue contract. */
export interface StorageSafetyIssue {
  code: string;
  severity: StorageSafetySeverity;
  message: string;
  recommendation: string;
}

/** Describes the public StorageSafetyProfile contract. */
export interface StorageSafetyProfile {
  status: StorageSafetyStatus;
  score: number;
  summary: string;
  storageDirectory: string;
  readOnly: boolean;
  lockStrategy: StorageLockStrategy;
  transactionLog: StorageTransactionLogMode;
  durability: StorageWriteDurability;
  writeProfile: StorageWriteProfile;
  staleLockRecovery: boolean;
  recoverCommittedWal: boolean;
  readCommittedWal: boolean;
  writeSnapshots: boolean;
  commitValidatorCount: number;
  pendingRecovery: boolean;
  hashChain: "present" | "missing" | "empty-store";
  issues: StorageSafetyIssue[];
}

/** Describes the public StorageHealthOptions contract. */
export interface StorageHealthOptions {
  verify?: boolean;
}

export type StorageHealthStatus = "healthy" | "warning" | "unsafe" | "error";

/** Describes the public StorageHealthReport contract. */
export interface StorageHealthReport {
  ok: boolean;
  status: StorageHealthStatus;
  checkedAt: string;
  operations: StorageOperationsStatus;
  safety: StorageSafetyProfile;
  verification?: VerificationResult;
}

/** Describes the public CompactionResult contract. */
export interface CompactionResult {
  kept: number;
  removed: number;
}

/** Describes the public GarbageCollectionResult contract. */
export interface GarbageCollectionResult {
  keptObjects: number;
  removedObjects: number;
  keptBinaryObjects: number;
  removedBinaryObjects: number;
  keptLazyFiles: number;
  removedLazyFiles: number;
}

/** Describes the public BackupResult contract. */
export interface BackupResult {
  filesCopied: number;
  transactionId: number;
  consistent: boolean;
}

/** Describes the public VerificationResult contract. */
export interface VerificationResult {
  ok: boolean;
  checkedObjects: number;
  checkedTransactions: number;
  checkedWalRecords: number;
  checkedIntegrityHashes: number;
  pendingWalCommits: number;
  warnings: string[];
  errors: string[];
}

/** Describes the public MaintenanceOptions contract. */
export interface MaintenanceOptions {
  keepSnapshots?: number;
  verify?: boolean;
}

/** Describes the public MaintenanceResult contract. */
export interface MaintenanceResult {
  garbageCollection: GarbageCollectionResult;
  compaction: CompactionResult;
  verification?: VerificationResult;
}

export type StoreMode = "standard" | "lazy" | "eager";

export type StorageWriteProfile = "standard" | "fast" | "maximum";

export type ObjectRecordWriteFormat = "binary-and-json" | "binary" | "json";

export type StorageWriteDurability = "strict" | "relaxed";

export type StorageLockStrategy = "startup" | "pessimistic" | "optimistic";

export type TransactionLockMode = "pessimistic" | "optimistic";

export type StorageTransactionLogMode = "full" | "off";

export type EagerFieldEvaluator = (context: {
  owner: object;
  fieldName: string;
  value: unknown;
}) => boolean;
