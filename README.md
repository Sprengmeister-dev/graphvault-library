# GraphVault Library

[![CI](https://github.com/Sprengmeister-dev/graphvault-library/actions/workflows/ci.yml/badge.svg)](https://github.com/Sprengmeister-dev/graphvault-library/actions/workflows/ci.yml)
![npm](https://img.shields.io/npm/v/%40sprengmeister%2Fgraphvault)
![Node](https://img.shields.io/badge/node-%3E%3D26-3c7a52)
![TypeScript](https://img.shields.io/badge/TypeScript-first-315c92)
![License](https://img.shields.io/badge/license-MIT-2f2f2f)

![GraphVault logo](./assets/graphvault-logo.png)

GraphVault is embedded object-graph persistence for TypeScript and NestJS applications whose natural data model is a live object graph: a root object with nested objects, arrays, maps, sets, shared references, cycles, and domain classes.

It is not a SQL server and it is not an ORM. You keep your domain model in memory, mutate normal TypeScript objects, then explicitly commit a verifiable graph store with WAL recovery, locking, indexes, GVQL, and an admin UI.

## 30-Second Quickstart

```bash
npm install @sprengmeister/graphvault
```

```ts
import { EmbeddedStorage } from "@sprengmeister/graphvault";

const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  root: { documents: [] },
});

storage.root.documents.push({ id: "doc-1", title: "Hello object graph" });
await storage.storeRoot();
await storage.shutdown();
```

## When To Use It

Use GraphVault when:

- your app owns a rich object model and you do not want to flatten it into tables
- object identity, shared references, cycles, classes, `Map`, `Set`, and rich JS values matter
- you want embedded persistence for a NestJS service, CLI, desktop app, simulation, rules engine, local-first tool, test harness, or admin-heavy internal tool
- writes should be explicit and auditable instead of hidden behind ORM change tracking
- a bounded graph slice should be easy to expose through an API with `loadSubtree({ depth })`

Reach for Postgres, SQLite, MongoDB, or Redis when:

- many unrelated systems need to write independently into the same database
- SQL compatibility, mature DBA tooling, replication, external roles, and ad-hoc reporting are central
- your data model is mostly records and indexes rather than a connected object graph
- you need a replicated consensus database rather than an embedded application-owned store

## What You Get

- TypeScript-native object graph persistence
- no database server required for embedded use cases
- preserves object identity, cycles, `Map`, `Set`, classes, and rich JS values
- explicit persistence instead of hidden ORM-style unit-of-work magic
- GVQL query language for graph traversal, indexed filters, grouping, aggregate analysis, execution plans, and safe batch-update previews
- persistent type, property, and graph-edge indexes for fast GVQL candidate selection
- explicit transactions with rollback plus optimistic or pessimistic locking for shared stores
- WAL recovery, fencing tokens, transaction-versioned object records, and a tamper-evident SHA-256 transaction hash chain for audit-oriented deployments
- transaction metadata for actor, reason, source, trace ID, tags, and audit attributes
- storage-wide schema migrations with `up` and `down`, persisted schema versions, and migration audit metadata
- production health and safety APIs for WAL, durability, stale-lock recovery, hash-chain, validator, and verification checks
- depth-limited subtree loading for bounded REST/API graph exposure
- optional AES-256-GCM encrypted storage-target wrapper for data at rest
- local filesystem, memory, HTTP, S3-compatible, and SQL-backed storage targets
- NestJS provider integration
- separate graphical admin tool: [GraphVault Studio](https://github.com/Sprengmeister-dev/graphvault-studio)
- maximum write profile for write-heavy local stores
- reproducible benchmark: [`npm run benchmark`](./docs/BENCHMARKS.md)

## NestJS In A Minute

GraphVault ships a NestJS module and a transaction decorator. The package smoke test installs a fresh NestJS 11 project, compiles this style of setup, writes data, verifies rollback, runs GVQL, closes the app, and reloads persisted data.

```ts
import { Injectable, Module } from "@nestjs/common";
import { GraphVaultModule, GraphVaultTransactional, StorageManager } from "@sprengmeister/graphvault";

class AppRoot {
  notes: Array<{ id: string; title: string; status: "draft" | "approved" }> = [];
}

@Injectable()
class NotesService {
  constructor(readonly storage: StorageManager<AppRoot>) {}

  @GraphVaultTransactional({ mode: "pessimistic", managerProperty: "storage" })
  async approve(id: string): Promise<void> {
    const note = this.storage.root.notes.find((item) => item.id === id);
    if (!note) throw new Error(`Unknown note ${id}`);
    note.status = "approved";
  }
}

@Module({
  imports: [
    GraphVaultModule.forRoot<AppRoot>({
      global: true,
      storageDirectory: "./data/graphvault",
      rootFactory: () => new AppRoot(),
      lockStrategy: "pessimistic",
      transactionLog: "full",
      recoverCommittedWal: true,
      readCommittedWal: true,
      staleLockTimeoutMs: 60_000,
    }),
  ],
  providers: [NotesService],
})
export class AppModule {}
```

See [NestJS integration](./docs/NESTJS.md).

## Admin UI

GraphVault Studio is the separate graphical admin client for browsing, searching, verifying, backing up, and editing stores.

![GraphVault Studio screenshot](https://raw.githubusercontent.com/Sprengmeister-dev/graphvault-studio/main/assets/studio-screenshot.png)

```bash
npm install graphvault-studio
npx graphvault-studio --dir ./data/graphvault --port 4177
```

Then open `http://127.0.0.1:4177`.

## Performance Snapshot

The benchmark is reproducible with `npm run benchmark`; the full table lives in [docs/BENCHMARKS.md](./docs/BENCHMARKS.md). Latest local run on macOS/Apple Silicon:

| target | documents | storeRoot | indexed GVQL aggregate | reload | storage size |
| --- | ---: | ---: | ---: | ---: | ---: |
| memory | 100 | 21.8 ms | 2.5 ms | 5.0 ms | - |
| filesystem | 100 | 2856.9 ms | 1.7 ms | 40.7 ms | 1.02 MiB |
| filesystem/maximum | 100 | 60.1 ms | 2.2 ms | 31.9 ms | 0.44 MiB |
| memory | 750 | 76.5 ms | 8.5 ms | 20.8 ms | - |
| filesystem | 750 | 19891.3 ms | 8.7 ms | 244.6 ms | 6.62 MiB |
| filesystem/maximum | 750 | 323.1 ms | 8.9 ms | 197.0 ms | 2.88 MiB |

The default filesystem profile favors inspectable JSON sidecars and conservative local durability. `writeProfile: "maximum"` is the write-heavy profile: binary object records, compact metadata, no debug-oriented duplicate object writes, and higher local write concurrency.

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

GVQL supports graph traversal, comma-separated `MATCH` patterns for joins, `OPTIONAL MATCH` for left-join style graph expansion, indexed metadata and property filters, indexed equality/`IN` intersections and `OR` unions, parenthesized `WHERE`/`HAVING` logic with `NOT` and SQL-style `AND` precedence, `WITH` pipelines, computed `RETURN` expressions, scalar functions, conditional `CASE` expressions, grouping, aggregates, `RETURN DISTINCT`, `count(DISTINCT path)`, pagination, execution plans, and preview-first batch updates with `CREATE`, idempotent `MERGE`, `SET`, arithmetic/conditional `SET` expressions, `REMOVE`, and `DELETE`. It is also what powers GraphVault Studio's search, inspection, and manipulation workflows.

## Persistent Indexes

GraphVault maintains a storage-wide `index.json` sidecar with type, property, and graph-edge lookup tables. The default `indexes: true` behavior indexes direct object properties automatically and GVQL reuses the persisted index when it matches the committed graph.

For very large graphs, keep index size predictable with configured properties:

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  rootFactory: () => ({ invoices: [] }),
  indexes: {
    mode: "configured",
    properties: ["id", "status", { type: "Invoice", path: "customerId" }],
  },
});
```

Use `await storage.indexStatus()` for operational visibility and `await storage.rebuildIndexes()` after changing index configuration. See [persistent indexes](./docs/INDEXES.md).

## Transactions And Concurrent Writers

Use `transaction(...)` when several related changes must succeed or fail as one unit. If the callback throws, GraphVault restores the previous in-memory root and does not commit the partial mutation.

```ts
await storage.transaction(
  ({ root }) => {
    const invoice = root.invoices.find((item) => item.id === "inv-1");
    invoice.status = "paid";
    root.auditLog.push({ type: "invoice-paid", invoiceId: invoice.id });
  },
  {
    mode: "pessimistic",
    metadata: {
      actor: "billing-service",
      reason: "invoice payment settlement",
      traceId: "payment-evt-7f3c",
    },
  },
);
```

For multi-pod deployments where several instances of the same application share one store, the transaction boundary is also the concurrency boundary:

- `pessimistic` transactions take the writer lock before reading and hold it until commit.
- `optimistic` transactions read first, then check at commit time whether another pod changed the store meanwhile; conflicts are retried or reported as `OptimisticLockError`.
- Every writer lock carries a monotonically increasing fencing token. Before GraphVault publishes commit metadata, it verifies that the token still owns the lock, so a pod that wakes up after its stale lock was replaced cannot publish an old write.
- `staleLockTimeoutMs` can recover a lock left behind by a crashed pod; set it above your expected maximum transaction runtime.

For ACID-oriented deployments, use `transactionLog: "full"`, `recoverCommittedWal: true`, `readCommittedWal: true`, `writeDurability: "strict"`, and application-specific `commitValidators`.

For NestJS services, `@GraphVaultTransactional()` wraps a service method in the same commit/rollback and locking behavior.

## Production Health Checks

GraphVault exposes a single health report for service checks, CI gates, and operations dashboards. It combines lightweight operational state, the production safety profile, and by default a real store verification pass.

```ts
const health = await storage.health();

if (!health.ok) {
  throw new Error(`GraphVault store is ${health.status}`);
}
```

For latency-sensitive endpoints, skip the full verification pass and reserve `verify()` or `health()` for deeper checks:

```ts
const health = await storage.health({ verify: false });
```

`healthy` means verification passed and the safety profile is production-ready. `warning` means the store is usable but has hardening recommendations. `unsafe` means a critical safety issue is present. `error` means verification failed.

## Bounded Subtree Exports

GraphVault can load only a bounded part of the stored object graph. This is useful for REST endpoints that should expose a focused subgraph without materializing or returning the whole store.

```ts
const subtree = await storage.loadSubtree("object-id", { depth: 2 });

return {
  graph: subtree.envelope,
  complete: subtree.complete,
  truncatedReferences: subtree.truncatedReferences,
};
```

`depth: 0` includes only the start object, `depth: 1` includes its direct referenced children, and so on. `truncatedReferences` tells callers which outgoing object references were intentionally left out at the boundary.

## Schema Migrations

Use storage-wide schema migrations when the persisted root graph needs to change shape across releases.

```ts
const storage = await EmbeddedStorage.start<AppRoot>({
  storageDirectory: "./data",
  rootFactory: () => ({ people: [] }),
  schemaVersion: 2,
  schemaMigrations: [
    {
      version: 1,
      name: "split-person-name",
      up: ({ root }) => {
        for (const person of root.people) {
          const [firstName, ...lastName] = person.fullName.split(" ");
          person.firstName = firstName;
          person.lastName = lastName.join(" ");
          delete person.fullName;
        }
      },
      down: ({ root }) => {
        for (const person of root.people) {
          person.fullName = `${person.firstName} ${person.lastName}`.trim();
          delete person.firstName;
          delete person.lastName;
        }
      },
    },
  ],
});

await storage.migrateTo();
```

Each migration step is committed as a normal pessimistic GraphVault transaction with WAL, fencing-token checks, schema version publication, and transaction metadata. See [schema migrations](./docs/SCHEMA_MIGRATIONS.md).

## Current Boundaries

GraphVault is intentionally application-owned embedded storage, not a drop-in replacement for a server database. It does not provide SQL wire-protocol compatibility, external user/role management, built-in replication, or distributed consensus. Multi-pod writers can share a store through the configured storage target and GraphVault's lock/transaction path, but high-availability replication and quorum semantics remain an infrastructure concern.

For critical production workloads, read [ACID configuration](./docs/ACID.md) and [Production operations](./docs/PRODUCTION.md), run the storage-target conformance tests for any custom target, and use application-specific `commitValidators` for domain invariants.

## Features

- application-owned root object
- explicit `storeRoot()`, `store(object)`, and storer APIs
- object identity, shared references, and cycles
- `Map`, `Set`, `Date`, `Buffer`, `bigint`, symbols, typed arrays, and other built-in JS values
- class registration, hydration, custom handlers, and schema migration hooks
- lazy references and segmented lazy arrays
- atomic commits, explicit transactions, manifest, transaction journal, verification, compaction, backup, and garbage collection
- optimistic and pessimistic locking for several pods/users writing to the same store
- storage-wide `up`/`down` schema migrations
- persistent GVQL indexes with automatic or configured property coverage
- depth-limited subtree loading for REST/API exports
- optional encrypted storage-target wrapper
- pluggable storage targets for local filesystem, memory, HTTP, S3-compatible clients, and SQL adapters
- optional NestJS integration

## Install

From npm:

```bash
npm install @sprengmeister/graphvault
```

GraphVault requires Node.js 26 or newer and ships ESM JavaScript plus TypeScript declarations.

## Basic Usage

GraphVault has one central concept: your application owns a root object. Everything reachable from that root can be stored as an object graph.

```ts
import { EmbeddedStorage } from "@sprengmeister/graphvault";

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

Open the generated store with GraphVault Studio:

```bash
npm install graphvault-studio
npx graphvault-studio --dir ./graphvault-example-store --port 4177
```

Then open `http://127.0.0.1:4177`.

## Documentation

- [Usage guide](./docs/USAGE.md) - modeling roots, registering classes, writing data, lazy data, verification, and lifecycle.
- [ACID configuration](./docs/ACID.md) - WAL, recovery, fencing tokens, validators, and durability tradeoffs.
- [Production operations](./docs/PRODUCTION.md) - production profiles, backup/restore, verification, monitoring, and known boundaries.
- [GVQL guide](./docs/GVQL.md) - graph queries, indexed filtering, aggregates, execution plans, and mutation previews.
- [Persistent indexes](./docs/INDEXES.md) - storage-wide index configuration, consistency modes, and rebuild operations.
- [Transactions and concurrency](./docs/TRANSACTIONS.md) - optimistic and pessimistic locking for multi-pod writers.
- [Storage configuration](./docs/STORAGE.md) - local filesystem, memory, HTTP, S3-compatible, SQL, and operational options.
- [NestJS integration](./docs/NESTJS.md) - module setup, async config, multiple stores, and shutdown hooks.
- [API reference](./docs/API.md) - public entry points and important options.
- [Benchmarks](./docs/BENCHMARKS.md) - reproducible performance numbers and write profiles.
- [0.2.0 release notes](./docs/RELEASE_NOTES_0.2.0.md) - production hardening, ACID-oriented recovery, subtree exports, and encrypted storage.
- [0.1.0 release notes](./docs/RELEASE_NOTES_0.1.0.md) - package overview for the first public release.
- [Publishing checklist](./docs/PUBLISHING.md) - local release checks, tagging, npm provenance, and GitHub topics.

## Performance

GraphVault includes a real benchmark instead of README-only claims:

```bash
npm run benchmark
```

Latest local results are documented in [docs/BENCHMARKS.md](./docs/BENCHMARKS.md). The short version: in-memory graph serialization is fast for typical embedded workloads; the default local filesystem profile is intentionally conservative, while `writeProfile: "maximum"` removes debug-oriented write duplication and is built for write-heavy paths.

## Developer Experience

```bash
npm ci
npm test
npm run benchmark:check
npm run pack:dry-run
npm run package:smoke
```

The smoke test stores and reloads a real object graph with class instances, shared references, maps, sets, and cycles. The package smoke test installs the generated tarball into a clean temporary project, verifies public and Studio-facing subpath imports, and compiles/runs a minimal NestJS app with injection, rollback, GVQL, health checks, backup, and restart persistence. CI runs on Node.js 26 and includes a source-size quality gate.

## Status And Scope

This is an early TypeScript implementation. The storage format is GraphVault-native, not a database-server protocol and not a JVM binary format. The project is designed for production discipline: explicit commits, verification, recovery paths, locking, and readable storage artifacts.
