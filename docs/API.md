# API Reference

## API Reference

### `EmbeddedStorage.start(...)`

Convenience entry point for embedded apps.

```ts
EmbeddedStorage.start(root, storageDirectory?)
EmbeddedStorage.start({ storageDirectory, root, rootFactory, types, ...options })
```

`startStorage(options)` is the same idea without the `root` shortcut. Use it when you prefer a function over the `EmbeddedStorage` facade.

### `StorageManager`

Main runtime API.

- `root`: loaded application root.
- `start()`: opens the store and loads or creates the root.
- `shutdown()`: releases timers and writer lock.
- `onApplicationShutdown()`: Nest-compatible shutdown hook that delegates to `shutdown()`.
- `storeRoot()`: stores the full reachable root graph, including nested mutable objects.
- `store(object)`: stores after a specific object changed. Passing the current root stores the full root graph.
- `storeAll(objects)` / `storeAll(...objects)`: stores after several objects changed.
- `update(mutator, storeTarget?)`: mutates and stores in one safe operation. Without `storeTarget`, it stores the full root graph.
- `transaction(work, options)`: groups related mutations into one commit with rollback plus pessimistic or optimistic multi-writer locking.
- `currentSchemaVersion()`: returns the schema version currently loaded by the store.
- `migrationStatus(targetVersion?)`: returns the current schema version, target version, latest known migration, and pending `up`/`down` steps.
- `migrateTo(targetVersion?)`: applies storage-wide schema migrations up or down. Without an argument, it migrates to `schemaVersion`.
- `indexStatus()`: returns persistent-index mode, consistency, transaction id, node count, property-key count, edge count, and whether the index is loaded, missing, stale, or disabled.
- `rebuildIndexes()`: takes the writer lock and rewrites the persistent index sidecar for the currently loaded root.
- `createStorer()`: batches several store targets into one commit.
- `createLazyRef(key, value)`: creates and stores lazy data.
- `loadLazy(key)` / `storeLazy(key, value)`: low-level lazy value access.
- `loadSubtree(options)` / `loadSubtree(objectId, options)`: loads a bounded object subgraph from the persisted store. `depth: 0` returns only the start object, `depth: 1` includes direct referenced objects, and higher values expand further. The result includes a `SerializedEnvelope`, loaded `objectIds`, `complete`, and `truncatedReferences`.
- `operations()`: returns lightweight monitoring state such as WAL counts, pending recovery, latest manifest/journal transaction ids, lock strategy, and object count.
- `safetyProfile()`: returns a production-readiness summary with `production-ready`, `warning`, or `unsafe` status plus concrete issues and recommendations for WAL, durability, stale-lock recovery, read-committed WAL behavior, snapshots, validators, pending recovery, and the transaction hash chain.
- `health(options)`: returns an operations + safety + optional verification report for service health checks and CI gates. By default it runs `verify()`. Pass `{ verify: false }` for a lightweight readiness check.
- `verify()`: validates manifest, transactions, transaction hash chain, WAL prepare/commit records, object records, references, and lazy files.
- `maintain(options)`: garbage collection, compaction, and optional verification.
- `compact(keepLatest)`: removes older snapshots.
- `collectGarbage()`: removes unreferenced object records.
- `backup(destination)`: copies the store to another directory or target. Consistent by default; takes the writer lock and excludes volatile lock files.

### Subtree Loading

```ts
const rootSlice = await storage.loadSubtree({ depth: 1 });
const objectSlice = await storage.loadSubtree("42", { depth: 2 });
```

`loadSubtree(...)` reads object records through the manifest and does not deserialize the full application root when a manifest exists. This makes it suitable for REST handlers, admin previews, and API responses where callers need a bounded part of the graph. The default depth is `1`.

The returned `truncatedReferences` array contains `{ fromObjectId, toObjectId, path, depth }` entries for outgoing object references that were outside the requested depth. A response with `complete: false` is intentionally partial, not corrupt.

### Health Reports

```ts
const report = await storage.health();

if (!report.ok) {
  throw new Error(`GraphVault store is ${report.status}`);
}
```

`StorageHealthReport.status` is:

- `healthy`: verification passed and the safety profile is production-ready.
- `warning`: verification passed, but the safety profile has hardening recommendations.
- `unsafe`: a critical safety issue exists, for example disabled WAL or pending recovery.
- `error`: verification failed.

Use `await storage.health({ verify: false })` for low-latency readiness endpoints and `await storage.health()` for startup gates, deployment checks, scheduled audits, or admin tooling.

### Schema Migrations

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  rootFactory: () => ({ people: [] }),
  schemaVersion: 2,
  schemaMigrations: migrations,
});

const status = storage.migrationStatus();
await storage.migrateTo();
await storage.migrateTo(1);
```

`StorageSchemaMigration.version` is the target version for its `up` function. Version `3` migrates from `2` to `3`; its `down` function migrates from `3` to `2`. Every migration step is committed as its own pessimistic transaction and records `metadata.schemaMigration` in the transaction journal.

See [schema migrations](./SCHEMA_MIGRATIONS.md) for the full operational pattern.

### Storage Targets

- `LocalFilesystemTarget`: default target for file-based embedded storage.
- `MemoryStorageTarget`: in-memory target for tests.
- `EncryptedStorageTarget`: AES-256-GCM wrapper around another target for encrypted object payloads at rest.
- `HttpStorageTarget`: remote service target.
- `S3StorageTarget`: S3-compatible object storage target.
- `SqlStorageTarget`: SQL-row-backed target.

### Important Options

- `storageDirectory`: required logical store root.
- `rootFactory`: creates the first root when no store exists.
- `root`: short form for bootstrapping with a concrete object.
- `types`: class registrations for prototype restoration and migrations.
- `storageTarget`: custom target; defaults to local filesystem.
- `readOnly`: opens without writer lock and rejects writes.
- `channelCount`: spreads object records across channel folders.
- `lockTimeoutMs`: writer-lock timeout.
- `staleLockTimeoutMs`: optional crash recovery for leftover writer locks; recovered locks receive newer fencing tokens.
- `lockStrategy`: `startup`, `pessimistic`, or `optimistic`.
- `optimisticMaxRetries` / `optimisticRetryDelayMs`: retry policy for optimistic transactions.
- `transactionLog`: `full` by default for WAL-based crash recovery, or `off` for disposable high-throughput stores.
- `recoverCommittedWal`: finishes committed WAL entries at startup; defaults to `true` when WAL is enabled.
- `readCommittedWal`: allows readers to load committed WAL entries before manifest repair; defaults to `true`.
- `commitValidators`: application invariants that must pass before WAL prepare and commit.
- `schemaVersion`: target storage-wide schema version.
- `schemaMigrations`: ordered or unordered list of `up`/`down` storage-wide migrations. Versions must be unique positive integers.
- `migrateOnStart`: runs `migrateTo(schemaVersion)` during startup after the root is loaded. For critical deployments, prefer an explicit migration job.
- `indexes`: persistent index configuration. `true` or omitted uses automatic direct-property indexing. Use `{ mode: "configured", properties: ["id", { type: "Invoice", path: "customerId" }] }` for bounded large-graph indexes, `{ mode: "off" }` to disable, and `consistency: "committed"` only when read queries intentionally target the last committed graph.
- `transaction(..., { metadata })`: records actor, reason, source, trace ID, tags, and simple audit attributes in the transaction record. Metadata is included in the transaction hash.
- `housekeepingIntervalMs`: periodic maintenance interval.
- `writeProfile`: `standard`, `fast`, or `maximum` write throughput profile.
- `writeDurability`: `strict` for fsynced local atomic writes, `relaxed` for higher throughput.
- `objectRecordFormat`: `binary-and-json`, `binary`, or `json`.
- `objectRecordWriteConcurrency`: parallelism for object-record writes.
- `prettyJson`: pretty metadata when `true`, compact metadata when `false`.
- `writeSnapshots`: checkpoint snapshot writes on or off.
