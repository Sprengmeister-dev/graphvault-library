# GraphVault TS

[![CI](https://github.com/Sprengmeister-dev/graphvault-library/actions/workflows/ci.yml/badge.svg)](https://github.com/Sprengmeister-dev/graphvault-library/actions/workflows/ci.yml)
![npm](https://img.shields.io/npm/v/%40sprengmeister%2Fgraphvault)
![Node](https://img.shields.io/badge/node-%3E%3D26-3c7a52)
![TypeScript](https://img.shields.io/badge/TypeScript-first-315c92)
![License](https://img.shields.io/badge/license-MIT-2f2f2f)

![GraphVault logo](./assets/graphvault-logo.jpg)

GraphVault is embedded object-graph persistence for TypeScript and NestJS applications whose natural data model is a live object graph: a root object with nested objects, arrays, maps, sets, shared references, cycles, and domain classes.

It is not a SQL server and it is not an ORM. You keep your domain model in memory, mutate normal TypeScript objects, then explicitly commit a verifiable graph store with WAL recovery, locking, indexes, GVQL, and an admin UI.

Current release: [0.2.5](./docs/RELEASE_NOTES_0.2.5.md), with field annotations for save/load filtering, professional persistent indexes, Node.js 26 validation, and NestJS smoke tests.

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

## Core Capabilities

- Persist rich TypeScript object graphs with identity, shared references, cycles, classes, `Map`, `Set`, `Date`, `Buffer`, `bigint`, typed arrays, and other JS values.
- Exclude sensitive or runtime-only class fields with field decorators such as `@GraphVaultIgnore()`, `@GraphVaultIgnoreSave()`, and `@GraphVaultIgnoreLoad()`.
- Query and batch-update committed graphs with GVQL, persistent indexes, execution plans, aggregates, previews, and GraphVault Studio.
- Run explicit transactions with rollback, optimistic or pessimistic locking, WAL recovery, fencing tokens, transaction metadata, and a tamper-evident hash chain.
- Operate stores with health/safety reports, verification, consistent backup, schema migrations, bounded subtree exports, and pluggable local, memory, HTTP, S3-compatible, SQLite-tested, and PostgreSQL-tested SQL storage targets.

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

```bash
npm install graphvault-studio
npx graphvault-studio --dir ./data/graphvault --port 4177
```

Then open `http://127.0.0.1:4177`.

## Performance Snapshot

The benchmark is reproducible with `npm run benchmark`; a comparative JSON/SQLite/GraphVault benchmark is available with `npm run benchmark:compare`. The full tables live in [docs/BENCHMARKS.md](./docs/BENCHMARKS.md). Latest local run on macOS/Apple Silicon:

| target | documents | storeRoot | indexed GVQL aggregate | reload | storage size |
| --- | ---: | ---: | ---: | ---: | ---: |
| memory | 100 | 21.8 ms | 2.5 ms | 5.0 ms | - |
| filesystem | 100 | 2856.9 ms | 1.7 ms | 40.7 ms | 1.02 MiB |
| filesystem/maximum | 100 | 60.1 ms | 2.2 ms | 31.9 ms | 0.44 MiB |
| memory | 750 | 76.5 ms | 8.5 ms | 20.8 ms | - |
| filesystem | 750 | 19891.3 ms | 8.7 ms | 244.6 ms | 6.62 MiB |
| filesystem/maximum | 750 | 323.1 ms | 8.9 ms | 197.0 ms | 2.88 MiB |

The default filesystem profile favors inspectable JSON sidecars and conservative local durability. `writeProfile: "maximum"` is the write-heavy profile: binary object records, compact metadata, no debug-oriented duplicate object writes, and higher local write concurrency.

## Important Workflows

- Query and manipulate graphs with [GVQL](./docs/GVQL.md): graph patterns, joins, aggregates, execution plans, previews, and batch updates.
- Keep sensitive or runtime-only model fields out of persistence with [field annotations](./docs/USAGE.md#field-annotations).
- Keep large stores fast with [persistent indexes](./docs/INDEXES.md): property, composite, range, text/substring, full-text token, unique, partial/sparse, and expression indexes with verify/repair operations.
- Protect concurrent writers with [transactions](./docs/TRANSACTIONS.md): rollback, optimistic and pessimistic locking, fencing tokens, stale-lock recovery, and NestJS decorators.
- Run production checks with [operations guidance](./docs/PRODUCTION.md) and [ACID configuration](./docs/ACID.md): WAL recovery, strict durability, verification, backups, health reports, and safety profiles.
- Expose bounded graph slices with [subtree loading](./docs/API.md#subtree-loading) and [NestJS REST examples](./docs/NESTJS.md#rest-subtree-endpoints).
- Evolve persisted roots with [schema migrations](./docs/SCHEMA_MIGRATIONS.md): storage-wide `up` and `down` steps committed through the same transaction path as application writes.

## Current Boundaries

GraphVault is intentionally application-owned embedded storage, not a drop-in replacement for a server database. It does not provide SQL wire-protocol compatibility, external user/role management, built-in replication, or distributed consensus. Multi-pod writers can share a store through the configured storage target and GraphVault's lock/transaction path, but high-availability replication and quorum semantics remain an infrastructure concern.

For critical production workloads, read [Guarantees and boundaries](./docs/GUARANTEES.md), [ACID configuration](./docs/ACID.md), and [Production operations](./docs/PRODUCTION.md), run the storage-target conformance tests for any custom target, and use application-specific `commitValidators` for domain invariants.

## Example Project

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

For a fuller graph-shaped product demo, see the [CaseGraph demo concept](./docs/CASEGRAPH.md): an investigation/case-management app where people, companies, accounts, payments, documents, notes, hypotheses, and timeline events form one navigable object graph.

## Documentation

- [Usage guide](./docs/USAGE.md) - modeling roots, registering classes, writing data, lazy data, cycles, verification, and lifecycle.
- [Guarantees and boundaries](./docs/GUARANTEES.md) - the precise contract for ACID-oriented behavior, storage-target requirements, tested paths, and when not to use GraphVault.
- [ACID configuration](./docs/ACID.md) - WAL, recovery, fencing tokens, validators, and durability tradeoffs.
- [Production operations](./docs/PRODUCTION.md) - production profiles, backup/restore, verification, monitoring, and known boundaries.
- [GVQL guide](./docs/GVQL.md) - graph queries, indexed filtering, aggregates, execution plans, and mutation previews.
- [Persistent indexes](./docs/INDEXES.md) - storage-wide index configuration, consistency modes, and rebuild operations.
- [Transactions and concurrency](./docs/TRANSACTIONS.md) - optimistic and pessimistic locking for multi-pod writers.
- [Storage configuration](./docs/STORAGE.md) - local filesystem, memory, HTTP, S3-compatible, SQL, and operational options.
- [NestJS integration](./docs/NESTJS.md) - module setup, async config, multiple stores, and shutdown hooks.
- [CaseGraph demo concept](./docs/CASEGRAPH.md) - the reference use case for graph-shaped, audit-heavy application data.
- [API reference](./docs/API.md) - public entry points and important options.
- [Benchmarks](./docs/BENCHMARKS.md) - reproducible performance numbers and write profiles.
- [0.2.5 release notes](./docs/RELEASE_NOTES_0.2.5.md) - field annotations for save/load filtering and current package baseline.
- [0.2.4 release notes](./docs/RELEASE_NOTES_0.2.4.md) - professional persistent indexes, index verification/repair, and current package baseline.
- [0.2.3 release notes](./docs/RELEASE_NOTES_0.2.3.md) - Node.js 26, NestJS smoke tests, and TypeScript developer polish.
- [0.2.0 release notes](./docs/RELEASE_NOTES_0.2.0.md) - production hardening, ACID-oriented recovery, subtree exports, and encrypted storage.
- [0.1.0 release notes](./docs/RELEASE_NOTES_0.1.0.md) - package overview for the first public release.
- [Publishing checklist](./docs/PUBLISHING.md) - local release checks, tagging, npm provenance, and GitHub topics.

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
