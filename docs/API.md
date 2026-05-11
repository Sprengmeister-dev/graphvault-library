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
- `storeRoot()`: stores the full root graph.
- `store(object)`: stores after a specific object changed.
- `storeAll(objects)` / `storeAll(...objects)`: stores after several objects changed.
- `update(mutator, storeTarget?)`: mutates and stores in one safe operation.
- `transaction(work, options)`: groups related mutations into one commit with rollback plus pessimistic or optimistic multi-writer locking.
- `createStorer()`: batches several store targets into one commit.
- `createLazyRef(key, value)`: creates and stores lazy data.
- `loadLazy(key)` / `storeLazy(key, value)`: low-level lazy value access.
- `verify()`: validates manifest, transactions, object records, and lazy files.
- `maintain(options)`: garbage collection, compaction, and optional verification.
- `compact(keepLatest)`: removes older snapshots.
- `collectGarbage()`: removes unreferenced object records.
- `backup(destination)`: copies the store to another directory or target.

### Storage Targets

- `LocalFilesystemTarget`: default target for file-based embedded storage.
- `MemoryStorageTarget`: in-memory target for tests.
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
- `housekeepingIntervalMs`: periodic maintenance interval.
- `writeProfile`: `standard`, `fast`, or `maximum` write throughput profile.
- `writeDurability`: `strict` for fsynced local atomic writes, `relaxed` for higher throughput.
- `objectRecordFormat`: `binary-and-json`, `binary`, or `json`.
- `objectRecordWriteConcurrency`: parallelism for object-record writes.
- `prettyJson`: pretty metadata when `true`, compact metadata when `false`.
- `writeSnapshots`: checkpoint snapshot writes on or off.
