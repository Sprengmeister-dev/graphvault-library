export { EmbeddedStorage } from "./embedded-storage.js";
export { decodeBinaryRecord, encodeBinaryRecord } from "./binary-codec.js";
export {
  buildGvqlGraphIndex,
  encodedValueToJs,
  executeGvqlStatement,
  jsValueToEncoded,
  matchBindings,
  parseGvql,
  propertyIndexKey,
  referencedEdges,
  visitEncodedNode,
} from "./gvql.js";
export type {
  GvqlAggregateFunction,
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
} from "./gvql.js";
export {
  GraphVaultModule,
  GRAPHVAULT_MANAGER,
  GRAPHVAULT_OPTIONS,
} from "./nest.js";
export type {
  DynamicModuleLike,
  GraphVaultModuleAsyncOptions,
  GraphVaultModuleOptions,
  NestProvider,
} from "./nest.js";
export {
  GraphVaultError,
  StorageLockError,
  StorageNotStartedError,
  ReadonlyStorageError,
  UnknownTypeError,
} from "./errors.js";
export { startStorage } from "./factory.js";
export { LazyArrayList } from "./lazy-array-list.js";
export { lazy, LazyRef } from "./lazy-ref.js";
export { PersistentCache } from "./persistent-cache.js";
export type { PersistentCacheRoot } from "./persistent-cache.js";
export { GraphSerializer, ObjectIdRegistry, TypeRegistry } from "./serializer.js";
export {
  copyStorageTargetTree,
  HttpStorageTarget,
  LocalFilesystemTarget,
  MemoryStorageTarget,
  S3StorageTarget,
  SqlStorageTarget,
} from "./storage-target.js";
export type {
  HttpStorageTargetOptions,
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
  SqlStorageTargetOptions,
} from "./storage-target.js";
export { StorageManager } from "./storage-manager.js";
export { Storer } from "./storer.js";
export type {
  ClassConstructor,
  BackupResult,
  CompactionResult,
  GarbageCollectionResult,
  SerializedEnvelope,
  ObjectRecord,
  ParentIndexRecord,
  ParentReference,
  StorageManifest,
  TypeDictionary,
  TypeDictionaryEntry,
  TransactionRecord,
  VerificationResult,
  MaintenanceResult,
  MaintenanceOptions,
  StorageManagerOptions,
  StorageStatus,
  StorageTarget,
  StorageTargetLock,
  StoreMetadata,
  StoreMode,
  StorageWriteDurability,
  StorageWriteProfile,
  ObjectRecordWriteFormat,
  TypeRegistration,
} from "./types.js";
