# Transactions And Multi-Pod Concurrency

GraphVault supports explicit transaction blocks for application workflows that must commit several related changes together or roll them back together.

For shared stores, the same transaction boundary is also the concurrency boundary. GraphVault reloads the latest committed graph before the work starts, protects the commit with the storage-target lock, and writes the full graph so nested object and array changes cannot be missed.

## Pessimistic Transactions

Pessimistic transactions acquire the writer lock before reading and keep it until the commit has finished. Use this for low-to-medium write rates, admin actions, payment-like workflows, and updates where waiting is better than retrying.

```ts
await storage.transaction(
  ({ root }) => {
    const document = root.documents.find((item) => item.id === "doc-1");
    document.status = "approved";
  },
  { mode: "pessimistic" },
);
```

## Optimistic Transactions

Optimistic transactions read without holding the writer lock, run your mutation, then acquire the writer lock and check whether the store changed meanwhile. If it changed, GraphVault rolls back the local mutation, reloads the latest graph, and retries.

```ts
const result = await storage.transaction(
  ({ root, attempt }) => {
    root.metrics.approvalCount += 1;
    root.audit.push({ type: "approval", attempt });
  },
  { mode: "optimistic", maxRetries: 3, retryDelayMs: 25 },
);

console.log(result.metadata.transactionId);
```

If all retries conflict, GraphVault throws `OptimisticLockError`.

## Store Configuration

For multi-pod applications, do not use the legacy startup writer lock. Configure a short-lived lock strategy instead:

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  rootFactory: () => ({ documents: [] }),
  lockStrategy: "optimistic",
  optimisticMaxRetries: 3,
  optimisticRetryDelayMs: 25,
  lockTimeoutMs: 10_000,
  staleLockTimeoutMs: 120_000,
});
```

Available strategies:

- `startup`: legacy single-writer mode; acquires the write lock for the whole manager lifetime.
- `pessimistic`: no startup lock; transactions default to pessimistic commit locking.
- `optimistic`: no startup lock; transactions default to optimistic conflict detection and retry.

`staleLockTimeoutMs` is optional crash recovery for shared stores. If a pod dies while holding the writer lock, a later writer may break that lock after the configured age. Set this value higher than the longest transaction you expect to allow; too low a value can let another writer break a still-valid long-running transaction.

Direct `store(...)`, `storeRoot()`, and `storeAll(...)` still perform a commit-version check before writing when no startup lock is held. For shared stores, prefer `transaction(...)` because it gives you a fresh root, rollback, retry behavior, and full-graph transactional persistence.

Inside a transaction, mutate `root` directly. Calling `update(...)` is also supported and acts as an in-memory mutation inside the outer transaction. Inner commit APIs such as `storeRoot()`, `store(...)`, `storeAll(...)`, `storer.commit()`, `storeLazy(...)`, or `createLazyRef(...)` are rejected with `TransactionScopeError`, because the outer transaction must be the only commit boundary.

## NestJS Decorator

Use `@GraphVaultTransactional()` on service methods that mutate GraphVault state. The decorator runs the method inside `storage.transaction(...)` and returns the original method result.

```ts
import { Injectable } from "@nestjs/common";
import { GraphVaultTransactional, StorageManager } from "@sprengmeister/graphvault";

@Injectable()
export class DocumentService {
  constructor(readonly storage: StorageManager<AppRoot>) {}

  @GraphVaultTransactional({ mode: "pessimistic", managerProperty: "storage" })
  async approve(id: string): Promise<string> {
    const document = this.storage.root.documents.find((item) => item.id === id);
    document.status = "approved";
    return document.status;
  }
}
```

If `managerProperty` is omitted, the decorator looks for `graphVault`, `storage`, `storageManager`, or `manager` on the service instance.
