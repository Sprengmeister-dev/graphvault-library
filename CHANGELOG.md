# Changelog

## 0.2.1

- Add `safetyProfile()` for production-readiness checks across WAL, durability, stale-lock recovery, read-committed WAL behavior, snapshots, commit validators, pending recovery, and the transaction hash chain.
- Export `assessStorageSafety(...)` for tools that want to classify GraphVault operational state without opening a full manager.

## 0.2.0

- Add explicit GraphVault transactions for shared stores.
- Add optimistic locking with commit-version checks, rollback, and retry.
- Add pessimistic transactions with short-lived writer locks for multi-pod writes.
- Add `@GraphVaultTransactional()` for NestJS service methods.
- Add fencing tokens for writer locks so stale recovered writers cannot publish old commits or release newer locks.
- Add configurable WAL-based crash recovery with `transactionLog`, `recoverCommittedWal`, and `readCommittedWal`.
- Extend verification with WAL prepare/commit checks, pending recovery counts, and warnings.
- Split commit/WAL publishing and write-profile resolution into dedicated storage modules.
- Add a production operations guide with deployment profiles, backup/restore, monitoring, and financial-workload guidance.
- Publish `manifest.json` last in the commit path and add a WAL crash matrix for recovery-sensitive failure phases.
- Make `storeRoot()` and default `update(...)` commits persist the full reachable root graph, including nested mutable objects.
- Add transaction-versioned object records so old manifests cannot observe partially written newer object records.
- Add a tamper-evident SHA-256 transaction hash chain and verification checks for audit-oriented stores.
- Add transaction metadata for actor, reason, source, trace ID, tags, and audit attributes protected by the transaction hash.
- Add a shared StorageTarget conformance suite for file, tree-copy, lock, stale-lock, and fencing-token behavior.
- Add `operations()` for lightweight production monitoring of WAL, recovery, manifest, journal, lock, and object-count state.
- Add JSON benchmark output and a conservative `benchmark:check` regression gate.
- Refresh benchmark documentation with GraphVault 0.2.0 WAL and versioned-object-record numbers.
- Add depth-limited subtree loading for bounded REST/API graph exposure.
- Add an optional AES-256-GCM encrypted storage-target wrapper for encrypted payloads at rest.
- Add a tarball install smoke test for public API and Studio-facing subpath exports.
- Make application-level backups consistent by default, writer-lock protected, WAL-aware, and free of volatile lock files.
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
