# GraphVault Library

GraphVault is a TypeScript persistence library for applications whose natural data model is an object graph: a root object with nested objects, arrays, maps, sets, shared references, cycles, and domain classes.

## Why Use This Instead Of A Normal Database?

Relational and document databases are excellent when your application is primarily about querying independent records. They become awkward when the important shape is an in-memory domain model with identity, links, and behavior. GraphVault is for cases where you want to keep that model intact and persist it deliberately.

Use GraphVault when:

- your app already has a rich object model and you do not want to flatten it into tables
- object identity and shared references matter
- you want explicit persistence calls such as `storeRoot()` and `store(object)`
- you want embedded storage for a service, CLI, desktop app, test harness, cache, rules engine, simulation, or local-first tool
- you want a simpler operational footprint than running a separate database server

Use a normal database when:

- many independent clients write concurrently
- ad-hoc querying, joins, indexes, reporting, and analytics are central
- you need SQL compatibility, database roles, replication, or mature DBA tooling
- the data model is naturally record-oriented rather than graph-oriented

GraphVault is not trying to replace Postgres, SQLite, MongoDB, or Redis. It is for the gap where those tools force you to translate a live object graph into a storage shape you do not otherwise want.

## Features

- application-owned root object
- explicit `storeRoot()`, `store(object)`, and storer APIs
- object identity, shared references, and cycles
- `Map`, `Set`, `Date`, `Buffer`, `bigint`, symbols, typed arrays, and other built-in JS values
- class registration, hydration, custom handlers, and schema migration hooks
- lazy references and segmented lazy arrays
- atomic commits, manifest, transaction journal, verification, compaction, backup, and garbage collection
- pluggable storage targets for local filesystem, memory, HTTP, S3-compatible clients, and SQL adapters
- optional NestJS integration

## Install

```bash
npm install graphvault
```

## Basic Usage

```ts
import { EmbeddedStorage } from "graphvault";

interface AppRoot {
  documents: Array<{ id: string; title: string; tags: string[] }>;
}

const storage = await EmbeddedStorage.start<AppRoot>({
  storageDirectory: "./data",
  root: { documents: [] },
});

storage.root.documents.push({
  id: "doc-1",
  title: "Design notes",
  tags: ["product", "architecture"],
});

await storage.storeRoot();
await storage.shutdown();
```

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
import { EmbeddedStorage, LocalFilesystemTarget } from "graphvault";

const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  storageTarget: new LocalFilesystemTarget(),
  rootFactory: () => ({ documents: [] }),
});
```

### In-Memory

Useful for tests and short-lived tools. Data disappears with the process.

```ts
import { EmbeddedStorage, MemoryStorageTarget } from "graphvault";

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
import { EmbeddedStorage, HttpStorageTarget } from "graphvault";

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
import { EmbeddedStorage, S3StorageTarget } from "graphvault";

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
import { EmbeddedStorage, SqlStorageTarget } from "graphvault";

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
  housekeepingIntervalMs: 60_000,
});
```

- `channelCount`: distributes object records across channel directories; use a power of two.
- `lockTimeoutMs`: how long a writer waits for the single-writer lock.
- `housekeepingIntervalMs`: enables periodic garbage collection and maintenance work.
- `readOnly`: opens a store without acquiring a writer lock or mutating files.

## NestJS

```ts
import { Inject, Injectable, Module } from "@nestjs/common";
import { GraphVaultModule, GRAPHVAULT_MANAGER, StorageManager } from "graphvault";

interface AppRoot {
  documents: unknown[];
}

@Module({
  imports: [
    GraphVaultModule.forRoot<AppRoot>({
      global: true,
      storageDirectory: "./data",
      rootFactory: () => ({ documents: [] }),
    }),
  ],
})
export class AppModule {}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(GRAPHVAULT_MANAGER)
    private readonly storage: StorageManager<AppRoot>,
  ) {}
}
```

## Admin UI

The graphical admin client lives in the separate [GraphVault Studio](https://github.com/Sprengmeister-dev/graphvault-studio) repository.

## Status

This is an early TypeScript implementation. The storage format is GraphVault-native, not a database-server protocol and not a JVM binary format. The project is designed for production discipline: explicit commits, verification, recovery paths, locking, and readable storage artifacts.
