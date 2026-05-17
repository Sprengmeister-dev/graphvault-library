/** Base error for GraphVault-specific failures that callers may want to catch separately. */
export class GraphVaultError extends Error {
  /** Creates a GraphVault error with an optional native error cause. */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Error thrown when code uses a StorageManager operation before start() completed. */
export class StorageNotStartedError extends GraphVaultError {}

/** Error thrown when a mutating operation is attempted on a read-only store. */
export class ReadonlyStorageError extends GraphVaultError {}

/** Error thrown when a storage target cannot acquire or validate the write lock. */
export class StorageLockError extends GraphVaultError {}

/** Error thrown when an optimistic write observes that another writer committed first. */
export class OptimisticLockError extends GraphVaultError {}

/** Error thrown when an operation would commit independently inside an active transaction. */
export class TransactionScopeError extends GraphVaultError {}

/** Error thrown when deserialization encounters a registered class name that is unavailable. */
export class UnknownTypeError extends GraphVaultError {}

/** Error thrown when persisted GraphVault data is structurally invalid or internally inconsistent. */
export class CorruptStorageError extends GraphVaultError {}
