# Storage Configuration

## Storage Configuration

GraphVault always has a logical `storageDirectory`. With the default local target, this is a filesystem path. With remote targets, it is the logical root or prefix inside that target.

### Local Filesystem

This is the default. It writes manifests, object records, binary object records, snapshots, transactions, and lock files below the directory.

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  rootFactory: () => ({ documents: [] }),
});
```

You can pass the target explicitly if you want to make the configuration obvious:

```ts
import { EmbeddedStorage, LocalFilesystemTarget } from "@sprengmeister/graphvault";

const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  storageTarget: new LocalFilesystemTarget(),
  rootFactory: () => ({ documents: [] }),
});
```

For write-heavy services, choose an explicit write profile:

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  rootFactory: () => ({ documents: [] }),
  writeProfile: "maximum",
});
```

Write profiles:

- `standard`: strict local writes, inspectable JSON object records, binary object records, snapshots, manifest, parent index, and journal.
- `fast`: relaxed local writes, compact JSON metadata, binary-only object records, snapshots, manifest, parent index, and journal.
- `maximum`: relaxed local writes, compact JSON metadata, binary-only object records, no checkpoint snapshots, manifest, parent index, and journal.

You can override the profile details with `objectRecordFormat`, `objectRecordWriteConcurrency`, `prettyJson`, `writeDurability`, and `writeSnapshots`.

### In-Memory

Useful for tests and short-lived tools. Data disappears with the process.

```ts
import { EmbeddedStorage, MemoryStorageTarget } from "@sprengmeister/graphvault";

const target = new MemoryStorageTarget();

const storage = await EmbeddedStorage.start({
  storageDirectory: "test-store",
  storageTarget: target,
  rootFactory: () => ({ documents: [] }),
});
```

### HTTP Remote Storage

`HttpStorageTarget` expects a storage service that exposes GraphVault-style object operations. Use this when your storage is behind an internal service or gateway.

```ts
import { EmbeddedStorage, HttpStorageTarget } from "@sprengmeister/graphvault";

const storage = await EmbeddedStorage.start({
  storageDirectory: "main",
  storageTarget: new HttpStorageTarget({
    baseUrl: "https://storage.example.com/graphvault",
    headers: { authorization: `Bearer ${process.env.STORAGE_TOKEN}` },
  }),
  rootFactory: () => ({ documents: [] }),
});
```

### S3-Compatible Storage

Use `S3StorageTarget` with an adapter for AWS S3, MinIO, Cloudflare R2, or another compatible object store.

```ts
import { EmbeddedStorage, S3StorageTarget } from "@sprengmeister/graphvault";

const storage = await EmbeddedStorage.start({
  storageDirectory: "prod/app-store",
  storageTarget: new S3StorageTarget({
    bucket: "graphvault-prod",
    prefix: "stores",
    client: s3ClientAdapter,
  }),
  rootFactory: () => ({ documents: [] }),
});
```

### SQL Storage

`SqlStorageTarget` stores each GraphVault storage path as a row and uses a separate lock table for single-writer coordination. The adapter only needs to expose parameterized `execute(...)` calls, so you can wrap your preferred PostgreSQL, MySQL, SQLite, or other SQL client.

```ts
import { EmbeddedStorage, SqlStorageTarget } from "@sprengmeister/graphvault";

const storage = await EmbeddedStorage.start({
  storageDirectory: "main",
  storageTarget: new SqlStorageTarget({
    client: sqlClientAdapter,
    tableName: "graphvault_objects",
    lockTableName: "graphvault_locks",
  }),
  rootFactory: () => ({ documents: [] }),
});
```

### Operational Options

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  rootFactory: () => ({ documents: [] }),
  channelCount: 4,
  lockTimeoutMs: 10_000,
  staleLockTimeoutMs: 120_000,
  transactionLog: "full",
  recoverCommittedWal: true,
  readCommittedWal: true,
  writeDurability: "strict",
  housekeepingIntervalMs: 60_000,
});
```

- `channelCount`: distributes object records across channel directories; use a power of two.
- `lockTimeoutMs`: how long a writer waits for the single-writer lock.
- `staleLockTimeoutMs`: optional crash recovery; after this age a leftover lock may be removed. Keep it above your longest expected transaction runtime. Recovered locks get newer fencing tokens, and stale writers are rejected before commit metadata is published.
- `lockStrategy`: `startup`, `pessimistic`, or `optimistic`. Use `pessimistic` or `optimistic` for shared stores with several pods.
- `transactionLog`: `full` enables WAL prepare/commit records; `off` skips WAL for disposable high-throughput stores.
- `recoverCommittedWal`: repairs committed-but-not-published WAL entries under the writer lock.
- `readCommittedWal`: lets readers load the newest committed WAL entry even before repair has published manifest metadata.
- `commitValidators`: application-level consistency checks that run before WAL prepare.
- `optimisticMaxRetries` and `optimisticRetryDelayMs`: retry policy for optimistic transactions.
- `housekeepingIntervalMs`: enables periodic garbage collection and maintenance work.
- `readOnly`: opens a store without acquiring a writer lock or mutating files.
- `writeProfile`: selects `standard`, `fast`, or `maximum` write behavior.
- `objectRecordFormat`: writes object records as `binary-and-json`, `binary`, or `json`.
- `objectRecordWriteConcurrency`: controls parallel object-record writes.
- `prettyJson`: keeps metadata human-formatted when `true`; compact JSON is faster and smaller.
- `writeDurability`: `strict` fsyncs local atomic writes; `relaxed` favors throughput.
- `writeSnapshots`: controls checkpoint snapshot writes; manifest-based loading still works without snapshots.
