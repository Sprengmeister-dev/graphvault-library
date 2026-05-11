export class GraphVaultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class StorageNotStartedError extends GraphVaultError {}

export class ReadonlyStorageError extends GraphVaultError {}

export class StorageLockError extends GraphVaultError {}

export class OptimisticLockError extends GraphVaultError {}

export class TransactionScopeError extends GraphVaultError {}

export class UnknownTypeError extends GraphVaultError {}

export class CorruptStorageError extends GraphVaultError {}
