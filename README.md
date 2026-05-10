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
