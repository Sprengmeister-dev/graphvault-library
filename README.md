# GraphVault Library

[![CI](https://github.com/Sprengmeister-dev/graphvault-library/actions/workflows/ci.yml/badge.svg)](https://github.com/Sprengmeister-dev/graphvault-library/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D20-3c7a52)
![TypeScript](https://img.shields.io/badge/TypeScript-first-315c92)
![License](https://img.shields.io/badge/license-MIT-2f2f2f)

GraphVault is a TypeScript persistence library for applications whose natural data model is an object graph: a root object with nested objects, arrays, maps, sets, shared references, cycles, and domain classes.

It is embedded, explicit, and TypeScript-first: you keep your domain model in memory, call `storeRoot()` or `store(object)` when you want durability, and GraphVault writes a verifiable object graph store.

## Highlights

- TypeScript-native object graph persistence
- no database server required for embedded use cases
- preserves object identity, cycles, `Map`, `Set`, classes, and rich JS values
- explicit persistence instead of hidden ORM-style unit-of-work magic
- GVQL query language for graph traversal, indexed filters, grouping, aggregate analysis, execution plans, and safe batch-update previews
- local filesystem, memory, HTTP, S3-compatible, and SQL-backed storage targets
- NestJS provider integration
- separate graphical admin tool: [GraphVault Studio](https://github.com/Sprengmeister-dev/graphvault-studio)
- reproducible benchmark: [`npm run benchmark`](./docs/BENCHMARKS.md)

## GVQL As A First-Class Feature

GraphVault includes GVQL, a TypeScript-friendly graph query and batch-update language for production tooling. It gives you SQL-like reach into an object graph without flattening your domain model into tables first.

```ts
const result = await storage.gvql(`
  MATCH (doc:Document)-[:owner]->(owner:Owner)
  WHERE owner.name = $owner AND doc.status IN ["draft", "review"]
  RETURN doc.status AS status, count(DISTINCT doc.id) AS documents
  GROUP BY doc.status
  ORDER BY documents DESC
`, {
  parameters: { owner: "Platform Team" },
});
```

GVQL supports graph traversal, indexed metadata and property filters, indexed equality/`IN` intersections and `OR` unions, parenthesized `WHERE`/`HAVING` logic with `NOT` and SQL-style `AND` precedence, computed `RETURN` expressions, grouping, aggregates, `RETURN DISTINCT`, `count(DISTINCT path)`, pagination, execution plans, and preview-first batch updates with `SET`, arithmetic `SET` expressions, `REMOVE`, and `DELETE`. It is also what powers GraphVault Studio's search, inspection, and manipulation workflows.

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

From GitHub today:

```bash
npm install github:Sprengmeister-dev/graphvault-library
```

Or pin the package name locally with an npm alias:

```bash
npm install graphvault@github:Sprengmeister-dev/graphvault-library
```

Registry publishing is planned. The unscoped npm name `graphvault` currently appears to be blocked by a previous unpublished package, so the first registry release may use `graphvault-library` or a scoped package name.

Once published to the npm registry:

```bash
npm install graphvault
```

## Basic Usage

GraphVault has one central concept: your application owns a root object. Everything reachable from that root can be stored as an object graph.

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

Run the complete JavaScript example:

```bash
npm run build
node examples/basic.mjs
```

## TypeScript Usage Guide

### Model Your Root

Use one root object for the part of your application state that belongs together. Plain objects work, but classes are usually nicer for domain-heavy apps.

```ts
import type { LazyRef } from "graphvault";

class Workspace {
  documents: Document[] = [];

  constructor(readonly name: string) {}
}

class Document {
  tags = new Set<string>();
  related = new Map<string, Document>();
  attachments = new Map<string, LazyRef<Buffer>>();

  constructor(
    readonly id: string,
    public title: string,
  ) {}
}

type AppRoot = Workspace;
```

### Start A Store

For a new store, `rootFactory` creates the initial root. For an existing store, GraphVault loads the persisted root and ignores the factory result.

```ts
import { EmbeddedStorage } from "graphvault";

const storage = await EmbeddedStorage.start<AppRoot>({
  storageDirectory: "./data/graphvault",
  rootFactory: () => new Workspace("Product"),
});
```

For scripts, tests, and bootstrap code, passing a concrete root is often the shortest path:

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data/graphvault",
  root: new Workspace("Product"),
});
```

### Register Classes

Register classes when you want loaded objects to keep their prototypes and methods.

```ts
const storage = await EmbeddedStorage.start<AppRoot>({
  storageDirectory: "./data/graphvault",
  rootFactory: () => new Workspace("Product"),
  types: [
    { name: "Workspace", ctor: Workspace },
    { name: "Document", ctor: Document },
  ],
});
```

You can version and migrate classes:

```ts
{
  name: "Document",
  ctor: Document,
  version: 2,
  create: () => new Document("", ""),
  migrate: (state, fromVersion) => {
    if (fromVersion < 2) {
      return { ...state, tags: [] };
    }
    return state;
  },
  hydrate: (target, state) => {
    target.title = String(state.title ?? "");
  },
}
```

### Read And Write Data

Mutate your root like normal TypeScript objects, then store explicitly.

```ts
const document = new Document("doc-1", "Storage design");
document.tags.add("architecture");

storage.root.documents.push(document);
await storage.storeRoot();
```

For service methods, `update(...)` is the most convenient shape. It stores after the mutator succeeds and rolls the in-memory root back if the mutator throws.

```ts
await storage.update((root) => {
  root.documents.push(new Document("doc-2", "Operational notes"));
});
```

When you only want to mark specific objects as the write target, use `store(object)` or `storeAll(...)`.

```ts
document.title = "Storage design v2";
await storage.store(document);

await storage.storeAll(storage.root.documents);
```

### Batch Writes With A Storer

Storers are useful when a workflow touches several objects and you want one commit at the end.

```ts
const storer = storage.createStorer();
storer.store(storage.root);
storer.storeAll(storage.root.documents);
await storer.commit();
```

### Lazy Data

Use `LazyRef` for large values that should live outside the main object graph until loaded.

```ts
const attachment = await storage.createLazyRef("attachments/doc-1", Buffer.from("content"));
storage.root.documents[0].attachments.set("main", attachment);
await storage.storeRoot();

const bytes = await attachment.get();
attachment.clear();
```

### Verification, Maintenance, And Backup

```ts
const verification = await storage.verify();
if (!verification.ok) {
  throw new Error(verification.errors.join("\n"));
}

await storage.maintain({ keepSnapshots: 2 });

await storage.backup({
  storageDirectory: "./backups/graphvault",
});
```

### Read-Only Access

Read-only mode is useful for admin jobs, export scripts, and safety checks. It does not acquire the writer lock and refuses mutations.

```ts
const storage = await EmbeddedStorage.start<AppRoot>({
  storageDirectory: "./data/graphvault",
  readOnly: true,
  rootFactory: () => new Workspace("unused"),
});
```

### Shutdown

Always shut the manager down in CLIs, tests, and worker processes so locks and timers are released cleanly.

```ts
try {
  await storage.update((root) => {
    root.documents.push(new Document("doc-3", "Release checklist"));
  });
} finally {
await storage.shutdown();
}
```

## GVQL Query And Batch Update

GVQL is GraphVault's graph query language. It follows the shape of modern property-graph languages: `MATCH` object patterns, filter with `WHERE`, project with `RETURN`, and use `SET`, `REMOVE`, or `DELETE` for controlled batch updates.

```ts
const result = await storage.gvql(`
  MATCH (doc:Document)-[:owner]->(owner:Owner)
  WHERE owner.name = $owner
  RETURN doc.id AS id, doc.title AS title
  ORDER BY doc.title ASC
  LIMIT 25
`, {
  parameters: { owner: "Platform Team" },
});
```

Batch updates are explicit and can be previewed first:

```ts
const preview = await storage.previewGvql(`
  MATCH (doc:Document)
  WHERE doc.status = "draft"
  SET doc.status = "archived"
  RETURN count(*) AS changed
`);

const committed = await storage.gvql(`
  MATCH (doc:Document)
  WHERE doc.status = "draft"
  SET doc.status = "archived"
  RETURN count(*) AS changed
`);
```

Numeric fields can be updated with arithmetic expressions:

```ts
const bumped = await storage.previewGvql(`
  MATCH (doc:Document)
  WHERE doc.status = "published"
  SET doc.views = (doc.views + $increment) * 2
  RETURN doc.id AS id, doc.views AS views
`, {
  parameters: { increment: 5 },
});
```

Remove optional object fields in the same preview-first workflow:

```ts
const cleanup = await storage.previewGvql(`
  MATCH (doc:Document)
  WHERE doc.archivedAt IS NOT NULL
  REMOVE doc.archivedAt
  RETURN count(*) AS changed
`);
```

Delete matched objects with parent-aware detach semantics:

```ts
const deletePreview = await storage.previewGvql(`
  MATCH (doc:Document)
  WHERE doc.status = "archived"
  DELETE doc
  RETURN doc.id AS id
`);
```

`DELETE` removes every direct parent reference to the matched alias before deleting the object node. If an object has multiple parents, all direct parents are detached in the same transaction. Deleting the root object is blocked.

Current GVQL supports:

- node patterns: `(doc:Document)` or `(node)`
- reference traversal: `-[:owner]->` and inverse traversal: `<-[:owner]-`
- `WHERE` predicates with `=`, `!=`, `<`, `<=`, `>`, `>=`, `CONTAINS`, `STARTS WITH`, `ENDS WITH`, `IN`, `IS NULL`, `IS NOT NULL`, `AND`, `OR`, `NOT`, and parentheses
- `$parameters`
- `RETURN`, `RETURN DISTINCT`, aliases with `AS`, arithmetic computed expressions such as `(doc.views + $bonus) * 2 AS score`, `count(*)`, `count(DISTINCT path)`, and virtual metadata paths `$id`, `$type`, `$kind`
- `GROUP BY` with `count`, `sum`, `avg`, `min`, `max`
- `HAVING` over returned aliases for aggregate filtering, with `AND`, `OR`, `NOT`, and parentheses
- `ORDER BY` paths and returned aliases, with multiple criteria plus `LIMIT` and `OFFSET`
- `SET` for primitive field updates, arithmetic `SET` expressions over numeric values, `REMOVE` for object-field cleanup, and parent-aware `DELETE alias`
- type indexes, primitive-property index intersections, indexed `IN` unions, and indexed `OR` unions for common filters on the first matched node
- indexed virtual metadata filters for `$id` and `$type`

Aggregate queries stay compact:

```ts
const totals = await storage.gvql(`
  MATCH (doc:Document)
  RETURN doc.status AS status, count(*) AS count, avg(doc.views) AS avgViews
  GROUP BY doc.status
  HAVING count >= $minimum
  ORDER BY avgViews DESC, status ASC
`, {
  parameters: { minimum: 5 },
});
```

Deduplicate projected rows with `RETURN DISTINCT`:

```ts
const statuses = await storage.gvql(`
  MATCH (doc:Document)
  RETURN DISTINCT doc.status AS status
  ORDER BY status ASC
`);
```

Find missing or populated optional fields with null checks:

```ts
const missingArchiveDate = await storage.gvql(`
  MATCH (doc:Document)
  WHERE doc.archivedAt IS NULL AND doc.status IS NOT NULL
  RETURN doc.id AS id, doc.title AS title
  ORDER BY doc.id ASC
`);
```

Every GVQL result also includes a compact execution plan so production tools can explain performance:

```ts
const result = await storage.gvql(`
  MATCH (doc:Document)
  WHERE doc.id = $id
  RETURN doc.title AS title
`, {
  parameters: { id: "doc-42" },
});

console.log(result.plan.candidateSource); // "property-index"
console.log(result.plan.startCandidates); // number of objects read from the first candidate set
```

For paginated admin screens or background jobs, use `LIMIT` with `OFFSET`:

```ts
const page = await storage.gvql(`
  MATCH (doc:Document)
  RETURN doc.id AS id, doc.title AS title
  ORDER BY doc.id ASC
  LIMIT 100
  OFFSET 200
`);
```

## Performance

GraphVault includes a real benchmark instead of README-only claims:

```bash
npm run benchmark
```

Latest local results are documented in [docs/BENCHMARKS.md](./docs/BENCHMARKS.md). The short version: in-memory graph serialization is fast for typical embedded workloads; the local filesystem target is intentionally conservative because it writes atomic binary records and inspectable JSON records.

## Developer Experience

```bash
npm ci
npm test
npm run benchmark
npm run pack:dry-run
```

The smoke test stores and reloads a real object graph with class instances, shared references, maps, sets, and cycles. CI runs on Node.js 20 and 22.

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

GraphVault is intentionally easy to wire into NestJS: import the module once, then inject `StorageManager<AppRoot>` directly in your services.

```ts
import { Injectable, Module } from "@nestjs/common";
import { GraphVaultModule, StorageManager } from "graphvault";

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
  constructor(private readonly storage: StorageManager<AppRoot>) {}

  async add(document: unknown): Promise<void> {
    await this.storage.update((root) => {
      root.documents.push(document);
    });
  }
}
```

### NestJS With ConfigService

Use `forRootAsync(...)` when the directory, target, or options come from configuration.

```ts
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { GraphVaultModule } from "graphvault";

@Module({
  imports: [
    ConfigModule.forRoot(),
    GraphVaultModule.forRootAsync<AppRoot>({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        storageDirectory: config.getOrThrow("GRAPHVAULT_DIR"),
        rootFactory: () => ({ documents: [] }),
        lockTimeoutMs: 10_000,
      }),
    }),
  ],
})
export class AppModule {}
```

### Multiple Stores In NestJS

For one store, direct `StorageManager<AppRoot>` injection is the cleanest option. If you need multiple stores in the same Nest app, inject by token from custom providers or wrap each store in a domain-specific service. The built-in token is exported as `GRAPHVAULT_MANAGER`:

```ts
import { Inject, Injectable } from "@nestjs/common";
import { GRAPHVAULT_MANAGER, StorageManager } from "graphvault";

@Injectable()
export class GraphVaultRootService {
  constructor(
    @Inject(GRAPHVAULT_MANAGER)
    readonly storage: StorageManager<AppRoot>,
  ) {}
}
```

### NestJS Shutdown

`StorageManager` exposes a Nest-compatible `onApplicationShutdown()` hook. Nest will close the store when the application shuts down through the Nest lifecycle. For OS signal handling, enable shutdown hooks in your bootstrap:

```ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(3000);
```

You can still call `await storage.shutdown()` directly in scripts, tests, and workers.


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
- `housekeepingIntervalMs`: periodic maintenance interval.

## Admin UI

The graphical admin client lives in the separate [GraphVault Studio](https://github.com/Sprengmeister-dev/graphvault-studio) repository.

## Status

This is an early TypeScript implementation. The storage format is GraphVault-native, not a database-server protocol and not a JVM binary format. The project is designed for production discipline: explicit commits, verification, recovery paths, locking, and readable storage artifacts.
