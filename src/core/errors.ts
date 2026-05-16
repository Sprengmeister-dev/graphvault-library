/** Provides the public GraphVaultError API. */
export class GraphVaultError extends Error {
  /** Creates a GraphVaultError instance. */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Provides the public StorageNotStartedError API. */
export class StorageNotStartedError extends GraphVaultError {}

/** Provides the public ReadonlyStorageError API. */
export class ReadonlyStorageError extends GraphVaultError {}

/** Provides the public StorageLockError API. */
export class StorageLockError extends GraphVaultError {}

/** Provides the public OptimisticLockError API. */
export class OptimisticLockError extends GraphVaultError {}

/** Provides the public TransactionScopeError API. */
export class TransactionScopeError extends GraphVaultError {}

/** Provides the public UnknownTypeError API. */
export class UnknownTypeError extends GraphVaultError {}

/** Provides the public CorruptStorageError API. */
export class CorruptStorageError extends GraphVaultError {}
