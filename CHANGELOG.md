# Changelog

## 0.2.8

- Replace placeholder-style TSDoc across the public TypeScript API with usage-oriented documentation for managers, storage targets, serializers, lazy helpers, GVQL helpers, and NestJS integration.
- Strengthen the source-quality gate so exported declarations and public members cannot regress to generic TSDoc such as `Runs X` or `Provides the public X API`.
- Extend the public-member TSDoc check to catch `static async` methods.

## 0.2.7

- Rename write profiles to `production`, `balanced`, and `inspect`.
- Make `production` the default write profile.
- Rename benchmark targets to `filesystem/production` and `filesystem/inspect`.

## 0.2.6

- Support Node.js 22+ explicitly, including current LTS lines.
- Validate CI on Node.js 22, 24, and 26.
- Run release and GitHub Packages publishing workflows on Node.js 24 LTS.
- Refresh README and release notes around the LTS runtime baseline.

## 0.2.5

- Add field annotations for excluding class fields during save and/or load.
- Export `GraphVaultIgnore`, `GraphVaultIgnoreSave`, `GraphVaultIgnoreLoad`, and low-level annotation helpers.
- Apply field annotations after custom `serialize(...)` and before custom `hydrate(...)` so class registrations compose with filtering.
- Document field annotations in README, usage guide, and API reference.

## 0.2.4

- Add professional persistent index families: composite, range, text/substring, full-text token, unique, partial/sparse, and expression indexes.
- Add `verifyIndexes()` and `repairIndexes()` for operational index checks and repair.
- Teach the GVQL planner to use advanced persistent indexes for common candidate selection.

## 0.2.3

- Fix NestJS `GraphVaultModule.forRoot(...)` and `forRootAsync(...)` TypeScript compatibility with real Nest module imports.
- Add a package smoke test that compiles and runs a minimal NestJS application with `StorageManager` injection, `@GraphVaultTransactional()`, and restart persistence.
- Refresh README and release notes around the current TypeScript developer baseline.

## 0.2.2

- Add persistent storage-wide indexes for type, property, and graph-edge lookup tables.
- Add configurable index coverage for large stores.
- Add `indexStatus()` and `rebuildIndexes()` for operational index administration.
- Teach GVQL to reuse committed indexes for common equality, `IN`, `OR`, aggregate, and traversal queries.
- Move the package and CI baseline to Node.js 26 and add source-size quality checks.

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

- Initial GraphVault TS package.
- Embedded TypeScript object graph persistence.
- Local filesystem and in-memory storage targets.
- HTTP, S3-compatible, and SQL storage target adapters.
- Class registration, object identity preservation, shared references, cycles, `Map`, `Set`, `Date`, `Buffer`, `bigint`, typed arrays, and rich JavaScript values.
- NestJS integration.
- Verification, transaction journal, backup, compaction, and garbage collection APIs.
- Reproducible object graph benchmark.
