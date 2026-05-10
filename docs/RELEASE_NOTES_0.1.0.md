# GraphVault Library 0.1.0 Release Notes

GraphVault Library 0.1.0 is the first public TypeScript implementation of GraphVault: an embedded object-graph database for application-owned domain models.

## What Is Included

- Embedded object graph persistence with one application-owned root object.
- TypeScript-first API with explicit `storeRoot()`, `store(object)`, `storeAll(...)`, `update(...)`, and storer workflows.
- Preservation of object identity, shared references, cycles, classes, `Map`, `Set`, dates, buffers, bigint, typed arrays, and rich JavaScript values.
- GVQL query language for graph traversal, indexed filtering, grouping, aggregates, computed returns, execution plans, and preview-first batch mutations.
- Local filesystem, memory, HTTP, S3-compatible, and SQL-backed storage targets.
- NestJS module integration.
- Verification, backup, compaction, garbage collection, transaction journal, manifest, parent index, and benchmark tooling.
- `writeProfile: "maximum"` for high-throughput local writes.

## Install

```bash
npm install graphvault@github:Sprengmeister-dev/graphvault-library
```

The package is ready for npm registry publishing. The intended import surface is:

```ts
import { EmbeddedStorage, StorageManager } from "graphvault";
```

## Quick Demo

```bash
npm ci
npm run build
node examples/basic.mjs
```

Then inspect the generated `graphvault-example-store` with GraphVault Studio:

```bash
npx graphvault-studio --dir ./graphvault-example-store --port 4177
```

## Recommended GitHub Topics

`typescript`, `nestjs`, `embedded-database`, `graph-database`, `object-graph`, `persistence`, `local-first`, `gvql`, `storage`, `database`
