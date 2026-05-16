/** Primary embedded storage entrypoint for opening and managing a GraphVault store. */
export { EmbeddedStorage } from "./storage/embedded-storage.js";
/** Binary object-record codec utilities used by high-throughput storage profiles. */
export { decodeBinaryRecord, encodeBinaryRecord } from "./core/binary-codec.js";
/** GVQL parser, executor, index, and value conversion primitives. */
export {
  buildGvqlGraphIndex,
  encodedValueToJs,
  executeGvqlStatement,
  jsValueToEncoded,
  matchBindings,
  parseGvql,
  propertyKey,
  propertyIndexKey,
  referencedEdges,
  visitEncodedNode,
} from "./gvql/gvql.js";
/** Public GVQL type model for queries, execution plans, mutations, and graph indexes. */
export type {
  GvqlGraphIndexBuildOptions,
  GvqlAggregateFunction,
  GvqlAdvancedGraphIndex,
  GvqlArithmeticOperator,
  GvqlBinding,
  GvqlCompareOperator,
  GvqlDirection,
  GvqlEdgePattern,
  GvqlExecutableContext,
  GvqlExecutionOptions,
  GvqlGraphEdge,
  GvqlGraphIndex,
  GvqlGraphNode,
  GvqlLiteral,
  GvqlLogicalOperator,
  GvqlMatchPattern,
  GvqlMutationPreview,
  GvqlMutationResult,
  GvqlNodePattern,
  GvqlOrderBy,
  GvqlPathExpression,
  GvqlPredicate,
  GvqlQueryResult,
  GvqlResult,
  GvqlReturnExpression,
  GvqlSetExpression,
  GvqlSetValueExpression,
  GvqlStatement,
  GvqlStatementKind,
  GvqlWhereClause,
} from "./gvql/gvql.js";
/** NestJS integration helpers for module registration and transactional methods. */
export {
  GraphVaultModule,
  GraphVaultTransactional,
  GRAPHVAULT_MANAGER,
  GRAPHVAULT_OPTIONS,
} from "./integrations/nest.js";
/** NestJS integration option and provider types. */
export type {
  DynamicModuleLike,
  GraphVaultModuleAsyncOptions,
  GraphVaultModuleOptions,
  GraphVaultTransactionalOptions,
  NestProvider,
} from "./integrations/nest.js";
/** Error classes thrown by GraphVault storage, locking, and serialization APIs. */
export {
  GraphVaultError,
  OptimisticLockError,
  StorageLockError,
  StorageNotStartedError,
  ReadonlyStorageError,
  TransactionScopeError,
  UnknownTypeError,
} from "./core/errors.js";
/** Convenience factory for starting a storage manager with options. */
export { startStorage } from "./storage/factory.js";
/** Lazy collection implementation for large graph segments. */
export { LazyArrayList } from "./lazy/lazy-array-list.js";
/** Lazy reference helpers for deferred object graph loading. */
export { lazy, LazyRef } from "./lazy/lazy-ref.js";
/** Persistent Map-like cache backed by GraphVault storage. */
export { PersistentCache } from "./cache/persistent-cache.js";
/** Root shape used by the persistent cache helper. */
export type { PersistentCacheRoot } from "./cache/persistent-cache.js";
/** Serialization building blocks for object identity, type registration, and graph envelopes. */
export { GraphSerializer, ObjectIdRegistry, TypeRegistry } from "./core/serializer.js";
/** Field decorators for excluding class fields from save and load phases. */
export {
  GraphVaultIgnore,
  GraphVaultIgnoreLoad,
  GraphVaultIgnoreSave,
  registerGraphVaultFieldAnnotation,
  shouldIgnoreGraphVaultField,
} from "./core/field-annotations.js";
/** Field annotation configuration types. */
export type { GraphVaultFieldAnnotation, GraphVaultIgnoreOptions } from "./core/field-annotations.js";
/** Storage target implementations for local, memory, encrypted, HTTP, S3, and SQL backends. */
export {
  copyStorageTargetTree,
  EncryptedStorageTarget,
  HttpStorageTarget,
  LocalFilesystemTarget,
  MemoryStorageTarget,
  S3StorageTarget,
  SqlStorageTarget,
} from "./storage/storage-target.js";
/** Storage target configuration and client contracts. */
export type {
  HttpStorageTargetOptions,
  EncryptedStorageTargetOptions,
  LocalFilesystemTargetOptions,
  S3Body,
  S3ListObjectsRequest,
  S3ListObjectsResponse,
  S3ObjectRequest,
  S3PutObjectRequest,
  S3StorageClient,
  S3StorageTargetOptions,
  SqlQueryResult,
  SqlStorageClient,
  SqlStorageDialect,
  SqlStorageTargetOptions,
} from "./storage/storage-target.js";
/** Full storage manager API for transactions, queries, verification, maintenance, and backups. */
export { StorageManager } from "./storage/storage-manager.js";
/** Computes a local production-safety profile from storage operations and write settings. */
export { assessStorageSafety } from "./storage/storage-safety.js";
/** Input shape for storage-safety assessment. */
export type { StorageSafetyAssessmentInput } from "./storage/storage-safety.js";
/** Unit-of-work helper for explicit object graph persistence. */
export { Storer } from "./storage/storer.js";
/** Core storage, manifest, transaction, index, migration, subtree, and health types. */
export type {
  ClassConstructor,
  BackupResult,
  CompactionResult,
  GarbageCollectionResult,
  SerializedEnvelope,
  ObjectRecord,
  ParentIndexRecord,
  ParentReference,
  StorageAdvancedIndexDefinitionRecord,
  StorageAdvancedIndexRecord,
  StorageCompositeIndexDefinition,
  StorageExpressionIndexDefinition,
  StorageFullTextIndexDefinition,
  StorageIndexCondition,
  StorageIndexConditionOperator,
  StorageIndexDefinition,
  StorageIndexEdge,
  StorageIndexOptions,
  StorageIndexStatistics,
  StorageIndexRecord,
  StorageIndexVerificationResult,
  StorageRangeIndexDefinition,
  StorageIndexStatus,
  StorageIndexConsistency,
  StorageIndexMode,
  StorageTextIndexDefinition,
  StorageUniqueIndexDefinition,
  StorageManifest,
  TypeDictionary,
  TypeDictionaryEntry,
  TransactionRecord,
  WalCommitRecord,
  WalPrepareRecord,
  WalRecord,
  VerificationResult,
  MaintenanceResult,
  MaintenanceOptions,
  StorageManagerOptions,
  StorageCommitValidator,
  StorageHealthOptions,
  StorageHealthReport,
  StorageHealthStatus,
  StorageOperationsStatus,
  StorageSafetyIssue,
  StorageSafetyProfile,
  StorageSafetySeverity,
  StorageSafetyStatus,
  StorageStatus,
  SubtreeLoadOptions,
  SubtreeLoadResult,
  SubtreeReference,
  StorageTarget,
  StorageTargetLock,
  StorageLockOptions,
  StorageLockStrategy,
  StorageTransactionLogMode,
  StoreMetadata,
  StoreMode,
  GraphVaultTransactionContext,
  GraphVaultTransactionOptions,
  GraphVaultTransactionResult,
  SchemaMigrationMetadata,
  StorageMigrationDirection,
  StorageMigrationPlanStep,
  StorageMigrationResult,
  StorageMigrationStatus,
  StorageMigrationStepResult,
  StorageSchemaMigration,
  StorageSchemaMigrationContext,
  TransactionLockMode,
  StorageWriteDurability,
  StorageWriteProfile,
  ObjectRecordWriteFormat,
  TypeRegistration,
} from "./core/types.js";
