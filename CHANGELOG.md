# Changelog

## 0.2.0

- Add explicit GraphVault transactions for shared stores.
- Add optimistic locking with commit-version checks, rollback, and retry.
- Add pessimistic transactions with short-lived writer locks for multi-pod writes.
- Add `@GraphVaultTransactional()` for NestJS service methods.
- Add fencing tokens for writer locks so stale recovered writers cannot publish old commits or release newer locks.
- Add configurable WAL-based crash recovery with `transactionLog`, `recoverCommittedWal`, and `readCommittedWal`.
- Extend verification with WAL prepare/commit checks, pending recovery counts, and warnings.
- Add `commitValidators` for application-level consistency gates before WAL prepare.
- Add concurrency tests that exercise two managers writing to the same store.

## 0.1.0

- Initial GraphVault Library package.
- Embedded TypeScript object graph persistence.
- Local filesystem and in-memory storage targets.
- HTTP, S3-compatible, and SQL storage target adapters.
- Class registration, object identity preservation, shared references, cycles, `Map`, `Set`, `Date`, `Buffer`, `bigint`, typed arrays, and rich JavaScript values.
- NestJS integration.
- Verification, transaction journal, backup, compaction, and garbage collection APIs.
- Reproducible object graph benchmark.
