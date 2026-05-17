export type ClassConstructor<T = object> = new (...args: never[]) => T;

/** Represents Type Registration in the public GraphVault data model. */
export interface TypeRegistration<T extends object = object> {
  name: string;
  ctor: ClassConstructor<T>;
  version?: number;
  create?: () => T;
  serialize?: (value: T) => Record<string, unknown>;
  hydrate?: (target: T, state: Record<string, unknown>, fromVersion: number) => void;
  migrate?: (state: Record<string, unknown>, fromVersion: number) => Record<string, unknown>;
}

/** Represents Serialized Envelope in the public GraphVault data model. */
export interface SerializedEnvelope {
  format: "graphvault";
  version: 1;
  createdAt: string;
  root: EncodedValue;
  nodes: Record<string, EncodedNode>;
}

/** Persisted record shape for Object. */
export interface ObjectRecord {
  format: "graphvault-object";
  version: 1;
  objectId: string;
  transactionId: number;
  storedAt: string;
  node: EncodedNode;
}

/** Represents Storage Manifest in the public GraphVault data model. */
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

/** Persisted record shape for Transaction. */
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

/** Metadata attached to Transaction records or operations. */
export interface TransactionMetadata {
  actor?: string;
  reason?: string;
  source?: string;
  traceId?: string;
  tags?: string[];
  attributes?: Record<string, string | number | boolean | null>;
  schemaMigration?: SchemaMigrationMetadata;
}

/** Metadata attached to Schema Migration records or operations. */
export interface SchemaMigrationMetadata {
  version: number;
  name?: string;
  direction: StorageMigrationDirection;
  fromVersion: number;
  toVersion: number;
}

/** Persisted record shape for Wal Prepare. */
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

/** Persisted record shape for Wal Commit. */
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

/** Represents Type Dictionary in the public GraphVault data model. */
export interface TypeDictionary {
  format: "graphvault-type-dictionary";
  version: 1;
  types: TypeDictionaryEntry[];
}

/** Persisted reverse-edge index that records all direct parents for every stored object. */
export interface ParentIndexRecord {
  format: "graphvault-parent-index";
  version: 1;
  transactionId: number;
  rootObjectId?: string;
  parents: Record<string, ParentReference[]>;
}

/** Represents Parent Reference in the public GraphVault data model. */
export interface ParentReference {
  parentObjectId: string;
  path: string;
}

export type StorageIndexMode = "off" | "auto" | "configured";
export type StorageIndexConsistency = "strict" | "committed";

/** Configuration for one Storage Index. */
export interface StorageIndexDefinition {
  type?: string;
  path: string;
}

export type StorageIndexConditionOperator = "=" | "!=" | "IN" | "IS NULL" | "IS NOT NULL";

/** Represents Storage Index Condition in the public GraphVault data model. */
export interface StorageIndexCondition {
  type?: string;
  path: string;
  operator?: StorageIndexConditionOperator;
  value?: unknown;
  values?: unknown[];
}

/** Configuration for one Storage Composite Index. */
export interface StorageCompositeIndexDefinition {
  name?: string;
  type?: string;
  paths: string[];
  unique?: boolean;
  sparse?: boolean;
  partial?: StorageIndexCondition;
}

/** Configuration for one Storage Range Index. */
export interface StorageRangeIndexDefinition extends StorageIndexDefinition {
  name?: string;
  sparse?: boolean;
  partial?: StorageIndexCondition;
}

/** Configuration for one Storage Text Index. */
export interface StorageTextIndexDefinition extends StorageIndexDefinition {
  name?: string;
  caseSensitive?: boolean;
  minGram?: number;
  maxGram?: number;
  sparse?: boolean;
  partial?: StorageIndexCondition;
}

/** Configuration for one Storage Full Text Index. */
export interface StorageFullTextIndexDefinition extends StorageIndexDefinition {
  name?: string;
  caseSensitive?: boolean;
  sparse?: boolean;
  partial?: StorageIndexCondition;
}

/** Configuration for one Storage Unique Index. */
export interface StorageUniqueIndexDefinition {
  name?: string;
  type?: string;
  path?: string;
  paths?: string[];
  sparse?: boolean;
  partial?: StorageIndexCondition;
}

/** Configuration for one Storage Expression Index. */
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

/** Options used to configure Storage Index behavior. */
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

/** Persisted record shape for Storage Index. */
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

/** Directed graph edge representation used by Storage Index. */
export interface StorageIndexEdge {
  from: string;
  to: string;
  path: string;
  label: string;
}

/** Persisted record shape for Storage Advanced Index. */
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

/** Persisted record shape for Storage Advanced Index Definition. */
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

/** Single entry in the Storage Range Index data structure. */
export interface StorageRangeIndexEntry {
  value: string;
  raw: unknown;
  objectIds: string[];
}

/** Represents Storage Index Statistics in the public GraphVault data model. */
export interface StorageIndexStatistics {
  entries: number;
  keys: number;
  maxBucketSize: number;
  averageBucketSize: number;
  selectivity: number;
}

/** Current status snapshot for Storage Index. */
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

/** Result returned by Storage Index Verification operations. */
export interface StorageIndexVerificationResult {
  ok: boolean;
  checkedIndexes: number;
  errors: string[];
  warnings: string[];
}

export type StorageConstraintMode = "off" | "enforce";
export type StorageConstraintKind = "required" | "type" | "enum" | "min" | "max" | "unique" | "referenceExists";
export type StorageConstraintValueType = "string" | "number" | "boolean" | "bigint" | "date" | "object" | "array" | "reference";

/** Configuration for one storage-wide field constraint. */
export interface StorageConstraintDefinition {
  name?: string;
  type?: string;
  path: string;
  required?: boolean;
  valueType?: StorageConstraintValueType;
  enum?: unknown[];
  min?: unknown;
  max?: unknown;
  unique?: boolean;
  referenceExists?: boolean;
  message?: string;
}

/** Options used to configure storage-wide constraint enforcement. */
export interface StorageConstraintOptions {
  mode?: StorageConstraintMode;
  definitions?: StorageConstraintDefinition[];
}

/** One rejected field value produced by storage constraint validation. */
export interface StorageConstraintViolation {
  name: string;
  kind: StorageConstraintKind;
  objectId: string;
  path: string;
  message: string;
  type?: string;
  value?: EncodedValue;
  conflictObjectId?: string;
}

/** Result returned by storage constraint validation. */
export interface StorageConstraintValidationResult {
  ok: boolean;
  mode: StorageConstraintMode;
  checkedObjects: number;
  checkedConstraints: number;
  violations: StorageConstraintViolation[];
}

/** Persisted record shape for the active storage constraint contract. */
export interface StorageConstraintRecord {
  format: "graphvault-constraints";
  version: 1;
  transactionId: number;
  createdAt: string;
  mode: StorageConstraintMode;
  definitions: StorageConstraintDefinition[];
  validation: StorageConstraintValidationResult;
}

/** Options used to configure Subtree Load behavior. */
export interface SubtreeLoadOptions {
  depth?: number;
  rootObjectId?: string;
}

/** Represents Subtree Reference in the public GraphVault data model. */
export interface SubtreeReference {
  fromObjectId: string;
  toObjectId: string;
  path: string;
  depth: number;
}

/** Result returned by Subtree Load operations. */
export interface SubtreeLoadResult {
  envelope: SerializedEnvelope;
  transactionId: number;
  depth: number;
  complete: boolean;
  objectIds: string[];
  truncatedReferences: SubtreeReference[];
  rootObjectId?: string;
}

/** Single entry in the Type Dictionary data structure. */
export interface TypeDictionaryEntry {
  name: string;
  version: number;
  /** Creates a Type Dictionary Entry with the supplied configuration. */
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

/** Primary configuration object for opening a GraphVault store. */
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
  constraints?: boolean | StorageConstraintOptions;
}

export type StorageCommitValidator<TRoot = unknown> = (context: {
  root: TRoot;
  envelope: SerializedEnvelope;
  transactionId: number;
}) => void | Promise<void>;

/** Backend abstraction GraphVault uses for file-like persistence, listing, atomic writes, appends, removal, and locks. */
export interface StorageTarget {
  /** Creates the directory namespace required by the storage layout when the backend needs one. */
  ensureDirectory(path: string): Promise<void>;
  /** Returns whether a storage path currently exists and can be read by this target. */
  exists(path: string): Promise<boolean>;
  /** Lists direct child names below a storage path. */
  list(path: string): Promise<string[]>;
  /** Reads a storage object as UTF-8 text. */
  readText(path: string): Promise<string>;
  /** Reads a storage object as bytes. */
  readBuffer(path: string): Promise<Buffer>;
  /** Writes UTF-8 text so readers see either the previous complete value or the new complete value. */
  writeTextAtomic(path: string, value: string): Promise<void>;
  /** Writes bytes so readers see either the previous complete value or the new complete value. */
  writeBufferAtomic(path: string, value: Buffer): Promise<void>;
  /** Appends UTF-8 text to an existing storage object, creating it when the backend supports that behavior. */
  appendText(path: string, value: string): Promise<void>;
  /** Deletes a storage path, optionally removing all nested children for directory-like backends. */
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** Acquires an exclusive storage lock and returns a fencing token that can be revalidated before publishing. */
  acquireLock(path: string, timeoutMs: number, options?: StorageLockOptions): Promise<StorageTargetLock>;
}

/** Options used to configure Storage Lock behavior. */
export interface StorageLockOptions {
  staleLockTimeoutMs?: number;
}

/** Acquired write lock with a fencing token that must remain valid while a commit is published. */
export interface StorageTargetLock {
  fencingToken: number;
  /** Verifies that this lock still owns the current fencing token before a protected write continues. */
  assertValid(): Promise<void>;
  /** Releases this storage lock if it still owns the current fencing token. */
  release(): Promise<void>;
}

/** Metadata attached to Store records or operations. */
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

/** Context passed to transaction callbacks, including the mutable root and retry attempt number. */
export interface GraphVaultTransactionContext<TRoot = unknown> {
  root: TRoot;
  transactionId: number;
  attempt: number;
}

/** Options for transaction lock mode, retries, persisted target selection, and audit metadata. */
export interface GraphVaultTransactionOptions<TRoot = unknown> {
  mode?: TransactionLockMode;
  maxRetries?: number;
  retryDelayMs?: number;
  storeTarget?: (root: TRoot) => unknown;
  metadata?: TransactionMetadata;
}

/** Result returned after a transaction commits, including user value, metadata, and retry details. */
export interface GraphVaultTransactionResult<T = unknown> {
  value: T;
  metadata: StoreMetadata;
  baseTransactionId: number;
  attempts: number;
  lockMode: TransactionLockMode;
}

export type StorageMigrationDirection = "up" | "down";

/** Context passed to a schema migration while it mutates the root graph. */
export interface StorageSchemaMigrationContext<TRoot = unknown> {
  root: TRoot;
  direction: StorageMigrationDirection;
  fromVersion: number;
  toVersion: number;
  version: number;
  name?: string;
}

/** Versioned schema migration with an up and down function for the application root graph. */
export interface StorageSchemaMigration<TRoot = unknown> {
  version: number;
  name?: string;
  up: (context: StorageSchemaMigrationContext<TRoot>) => void | Promise<void>;
  down: (context: StorageSchemaMigrationContext<TRoot>) => void | Promise<void>;
}

/** Current status snapshot for Storage Migration. */
export interface StorageMigrationStatus {
  currentVersion: number;
  targetVersion: number;
  latestAvailableVersion: number;
  pending: StorageMigrationPlanStep[];
}

/** Represents Storage Migration Plan Step in the public GraphVault data model. */
export interface StorageMigrationPlanStep {
  version: number;
  name?: string;
  direction: StorageMigrationDirection;
  fromVersion: number;
  toVersion: number;
}

/** Result returned by Storage Migration Step operations. */
export interface StorageMigrationStepResult extends StorageMigrationPlanStep {
  metadata: StoreMetadata;
}

/** Result returned by Storage Migration operations. */
export interface StorageMigrationResult {
  fromVersion: number;
  toVersion: number;
  applied: StorageMigrationStepResult[];
  skipped: boolean;
}

/** Current status snapshot for Storage. */
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

/** Current status snapshot for Storage Operations. */
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

/** One reported Storage Safety issue with severity and remediation text. */
export interface StorageSafetyIssue {
  code: string;
  severity: StorageSafetySeverity;
  message: string;
  recommendation: string;
}

/** Represents Storage Safety Profile in the public GraphVault data model. */
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

/** Options used to configure Storage Health behavior. */
export interface StorageHealthOptions {
  verify?: boolean;
}

export type StorageHealthStatus = "healthy" | "warning" | "unsafe" | "error";

/** Represents Storage Health Report in the public GraphVault data model. */
export interface StorageHealthReport {
  ok: boolean;
  status: StorageHealthStatus;
  checkedAt: string;
  operations: StorageOperationsStatus;
  safety: StorageSafetyProfile;
  verification?: VerificationResult;
}

/** Result returned by Compaction operations. */
export interface CompactionResult {
  kept: number;
  removed: number;
}

/** Result returned by Garbage Collection operations. */
export interface GarbageCollectionResult {
  keptObjects: number;
  removedObjects: number;
  keptBinaryObjects: number;
  removedBinaryObjects: number;
  keptLazyFiles: number;
  removedLazyFiles: number;
}

/** Result returned by Backup operations. */
export interface BackupResult {
  filesCopied: number;
  transactionId: number;
  consistent: boolean;
}

/** Result returned by Verification operations. */
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

/** Options used to configure Maintenance behavior. */
export interface MaintenanceOptions {
  keepSnapshots?: number;
  verify?: boolean;
}

/** Result returned by Maintenance operations. */
export interface MaintenanceResult {
  garbageCollection: GarbageCollectionResult;
  compaction: CompactionResult;
  verification?: VerificationResult;
}

export type StoreMode = "standard" | "lazy" | "eager";

export type StorageWriteProfile = "production" | "balanced" | "inspect";

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
