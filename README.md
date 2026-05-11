# GraphVault Library

[![CI](https://github.com/Sprengmeister-dev/graphvault-library/actions/workflows/ci.yml/badge.svg)](https://github.com/Sprengmeister-dev/graphvault-library/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D20-3c7a52)
![TypeScript](https://img.shields.io/badge/TypeScript-first-315c92)
![License](https://img.shields.io/badge/license-MIT-2f2f2f)

![GraphVault logo](./assets/graphvault-logo.png)

GraphVault is an embedded TypeScript object-graph database for applications whose natural data model is a live object graph: a root object with nested objects, arrays, maps, sets, shared references, cycles, and domain classes.

It is embedded, explicit, and TypeScript-first: you keep your domain model in memory, call `storeRoot()` or `store(object)` when you want durability, and GraphVault writes a verifiable object graph store.

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

## Highlights

- TypeScript-native object graph persistence
- no database server required for embedded use cases
- preserves object identity, cycles, `Map`, `Set`, classes, and rich JS values
- explicit persistence instead of hidden ORM-style unit-of-work magic
- GVQL query language for graph traversal, indexed filters, grouping, aggregate analysis, execution plans, and safe batch-update previews
- explicit transactions with rollback plus optimistic or pessimistic locking for shared stores
- WAL recovery, fencing tokens, transaction-versioned object records, and a tamper-evident SHA-256 transaction hash chain for audit-oriented deployments
- transaction metadata for actor, reason, source, trace ID, tags, and audit attributes
- production safety profile API for WAL, durability, stale-lock recovery, hash-chain, and validator checks
- depth-limited subtree loading for bounded REST/API graph exposure
- optional AES-256-GCM encrypted storage-target wrapper for data at rest
- local filesystem, memory, HTTP, S3-compatible, and SQL-backed storage targets
- NestJS provider integration
- separate graphical admin tool: [GraphVault Studio](https://github.com/Sprengmeister-dev/graphvault-studio)
- maximum write profile for write-heavy local stores
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

GVQL supports graph traversal, comma-separated `MATCH` patterns for joins, `OPTIONAL MATCH` for left-join style graph expansion, indexed metadata and property filters, indexed equality/`IN` intersections and `OR` unions, parenthesized `WHERE`/`HAVING` logic with `NOT` and SQL-style `AND` precedence, `WITH` pipelines, computed `RETURN` expressions, scalar functions, conditional `CASE` expressions, grouping, aggregates, `RETURN DISTINCT`, `count(DISTINCT path)`, pagination, execution plans, and preview-first batch updates with `CREATE`, idempotent `MERGE`, `SET`, arithmetic/conditional `SET` expressions, `REMOVE`, and `DELETE`. It is also what powers GraphVault Studio's search, inspection, and manipulation workflows.

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

## Why Use This Instead Of A Normal Database?

Relational and document databases are excellent when your application is primarily about querying independent records. They become awkward when the important shape is an in-memory domain model with identity, links, and behavior. GraphVault is for cases where you want to keep that model intact and persist it deliberately.

Use GraphVault when:

- your app already has a rich object model and you do not want to flatten it into tables
- object identity and shared references matter
- you want explicit persistence calls such as `storeRoot()` and `store(object)`
- you want embedded storage for a service, CLI, desktop app, test harness, cache, rules engine, simulation, or local-first tool
- you want a simpler operational footprint than running a separate database server

Use a normal database when:

- many independent clients outside one application boundary write concurrently
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
- atomic commits, explicit transactions, manifest, transaction journal, verification, compaction, backup, and garbage collection
- optimistic and pessimistic locking for several pods/users writing to the same store
- depth-limited subtree loading for REST/API exports
- optional encrypted storage-target wrapper
- pluggable storage targets for local filesystem, memory, HTTP, S3-compatible clients, and SQL adapters
- optional NestJS integration

## Install

From npm:

```bash
npm install @sprengmeister/graphvault
```

GraphVault requires Node.js 20 or newer and ships ESM JavaScript plus TypeScript declarations.

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
npm install @sprengmeister/graphvault-studio
npx graphvault-studio --dir ./graphvault-example-store --port 4177
```

Then open `http://127.0.0.1:4177`.

## Documentation

- [Usage guide](./docs/USAGE.md) - modeling roots, registering classes, writing data, lazy data, verification, and lifecycle.
- [ACID configuration](./docs/ACID.md) - WAL, recovery, fencing tokens, validators, and durability tradeoffs.
- [Production operations](./docs/PRODUCTION.md) - production profiles, backup/restore, verification, monitoring, and known boundaries.
- [GVQL guide](./docs/GVQL.md) - graph queries, indexed filtering, aggregates, execution plans, and mutation previews.
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

The smoke test stores and reloads a real object graph with class instances, shared references, maps, sets, and cycles. The package smoke test installs the generated tarball into a clean temporary project and verifies public and Studio-facing subpath imports. CI runs on Node.js 20 and 22.

## Admin UI

The graphical admin client lives in the separate [GraphVault Studio](https://github.com/Sprengmeister-dev/graphvault-studio) repository.

## Status

This is an early TypeScript implementation. The storage format is GraphVault-native, not a database-server protocol and not a JVM binary format. The project is designed for production discipline: explicit commits, verification, recovery paths, locking, and readable storage artifacts.
