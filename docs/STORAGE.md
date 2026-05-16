# Storage Configuration

## Storage Configuration

GraphVault always has a logical `storageDirectory`. With the default local target, this is a filesystem path. With remote targets, it is the logical root or prefix inside that target.

### Local Filesystem

This is the default. It writes manifests, object records, binary object records, snapshots, transactions, and lock files below the directory.

Object records are transaction-versioned. The manifest stores the live object id list plus the transaction version to read for each object, which lets garbage collection remove old versions while preserving crash-safe manifest reads.

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

### Encrypted Storage Wrapper

Wrap any storage target with `EncryptedStorageTarget` when the target should only see encrypted object payloads at rest. The wrapper uses AES-256-GCM and accepts either a 32-byte key or a passphrase string that is hashed to a 256-bit key.

```ts
import { EmbeddedStorage, EncryptedStorageTarget, LocalFilesystemTarget } from "@sprengmeister/graphvault";

const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  storageTarget: new EncryptedStorageTarget({
    target: new LocalFilesystemTarget(),
    key: process.env.GRAPHVAULT_STORAGE_KEY!,
  }),
  rootFactory: () => ({ documents: [] }),
});
```

Store and rotate keys through your deployment secrets manager. GraphVault cannot recover encrypted payloads if the key is lost.

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

The HTTP service must implement the same contract as the built-in targets:

- `PUT ?directory=1` creates a logical directory.
- `HEAD` reports file or directory existence.
- `GET ?list=1` returns direct child names.
- `GET` returns the object body.
- `PUT` atomically replaces an object.
- `POST ?append=1` appends text for journal-style writes.
- `DELETE` removes an object, and `DELETE ?recursive=1` removes a subtree.
- `PUT ?lock=1` creates a lock only if it does not already exist.

The shared storage-target conformance test exercises local filesystem, memory, and HTTP implementations for file semantics, recursive deletion, tree copy, lock conflicts, stale-lock recovery, token-aware release, and monotonically increasing fencing tokens. Run it when implementing a custom target or storage gateway:

```sh
node tests/storage-target-conformance.test.mjs
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

`SqlStorageTarget` stores each GraphVault storage path as a row and uses a separate lock table for single-writer coordination. The adapter only needs to expose parameterized `execute(...)` calls, so you can wrap your preferred PostgreSQL, SQLite, MySQL-style, or other SQL client.

```ts
import { EmbeddedStorage, SqlStorageTarget } from "@sprengmeister/graphvault";

const storage = await EmbeddedStorage.start({
  storageDirectory: "main",
  storageTarget: new SqlStorageTarget({
    client: sqlClientAdapter,
    tableName: "graphvault_objects",
    lockTableName: "graphvault_locks",
    dialect: "postgres",
  }),
  rootFactory: () => ({ documents: [] }),
});
```

Dialects:

- `postgres`: uses `$1`, `$2`, ... placeholders and `BYTEA` payload columns.
- `sqlite`: uses `?` placeholders and `BLOB` payload columns.
- `question`: default compatibility mode for SQL clients that accept `?` placeholders.

PostgreSQL with `pg`:

```ts
import pg from "pg";
import { EmbeddedStorage, SqlStorageTarget, type SqlStorageClient } from "@sprengmeister/graphvault";

const pool = new pg.Pool({
  connectionString: process.env.GRAPHVAULT_POSTGRES_URL,
});

class PgGraphVaultClient implements SqlStorageClient {
  private transactionClient?: pg.PoolClient;

  async execute(sql: string, parameters: readonly unknown[] = []) {
    const client = this.transactionClient ?? pool;
    const result = await client.query(sql, parameters);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  async transaction<T>(work: () => Promise<T>) {
    if (this.transactionClient) return work();
    const client = await pool.connect();
    this.transactionClient = client;
    try {
      await client.query("BEGIN");
      const result = await work();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      this.transactionClient = undefined;
      client.release();
    }
  }
}

const storage = await EmbeddedStorage.start({
  storageDirectory: "prod/main",
  storageTarget: new SqlStorageTarget({
    client: new PgGraphVaultClient(),
    dialect: "postgres",
  }),
  rootFactory: () => ({ documents: [] }),
  lockStrategy: "pessimistic",
  transactionLog: "full",
  staleLockTimeoutMs: 120_000,
});
```

For multi-pod deployments, every pod must point at the same database, table names, `storageDirectory`, lock strategy, and compatible GraphVault version. The CI suite runs the PostgreSQL integration test against a real Postgres service, and the local test can be enabled with:

```sh
GRAPHVAULT_POSTGRES_URL=postgresql://user:password@localhost:5432/graphvault npm test
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
  indexes: {
    mode: "configured",
    properties: ["id", "status"],
  },
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
- `indexes`: controls the persistent GVQL index sidecar. Omit it or pass `true` for automatic direct-property indexes, use `mode: "configured"` with selected property, composite, range, text/substring, full-text token, unique, partial/sparse, and expression indexes for large graphs, or `mode: "off"` for disposable stores that do not query.
