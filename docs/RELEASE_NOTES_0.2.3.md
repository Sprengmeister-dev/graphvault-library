# GraphVault TS 0.2.3 Release Notes

GraphVault TS 0.2.3 is the current public TypeScript developer release. It builds on the 0.2.0 production-hardening work with persistent indexes, Node.js LTS validation, a tighter package smoke test, and clearer documentation for NestJS and production adoption.

## Why Upgrade

Use 0.2.3 if you want the current package baseline for real TypeScript and NestJS projects. Compared with 0.2.0, this release adds storage-wide persistent indexes for GVQL, validates the package on Node.js LTS, and verifies the npm tarball inside a fresh NestJS application before publishing.

## What Is New Since 0.2.0

- Persistent storage-wide indexes in `index.json` for type, property, and graph-edge lookups.
- Configurable index coverage with automatic direct-property indexing by default and explicit property lists for very large graphs.
- `indexStatus()` and `rebuildIndexes()` for operational index administration.
- GVQL planning that can reuse committed indexes for equality, `IN`, `OR`, aggregate, and graph traversal queries.
- Node.js LTS engine and CI baseline.
- Source-size quality gate so the TypeScript source stays split into maintainable modules.
- Smaller storage-manager internals with dedicated modules for garbage collection, health, migrations, object collection, and root helpers.
- NestJS dynamic module type fixes for `GraphVaultModule.forRoot(...)` and `forRootAsync(...)`.
- Package smoke test that installs the generated tarball into a clean project and compiles/runs a minimal NestJS app with injection, transactional rollback, GVQL, health checks, backup, restart persistence, and Studio-facing subpath imports.
- README refresh focused on quickstart, fit, core capabilities, and deep links instead of duplicating the full documentation set.

## Recommended Baseline

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data/graphvault",
  rootFactory: () => ({ documents: [] }),
  lockStrategy: "pessimistic",
  transactionLog: "full",
  recoverCommittedWal: true,
  readCommittedWal: true,
  writeDurability: "strict",
  staleLockTimeoutMs: 120_000,
  indexes: {
    mode: "configured",
    properties: ["id", "status", { type: "Document", path: "ownerId" }],
  },
});
```

For write-heavy embedded stores, use the default `writeProfile: "production"` and keep `transactionLog: "full"` unless the store is disposable.

## Persistent Indexes

GraphVault now keeps a committed index sidecar next to the store manifest. The index contains object type lookups, selected property values, and graph-edge information. GVQL uses that sidecar when it matches the committed graph, which lets admin tools and application queries avoid repeatedly scanning the full graph for common predicates.

```ts
const status = await storage.indexStatus();

if (!status.ok) {
  await storage.rebuildIndexes();
}
```

See [persistent indexes](./INDEXES.md).

## NestJS Confidence

The package-level smoke test now validates the real consumer path: it packs GraphVault, installs it into a clean temporary project, compiles a NestJS application, writes and rolls back data through `@GraphVaultTransactional()`, runs GVQL, checks health and backup APIs, shuts down, and reloads persisted data.

See [NestJS integration](./NESTJS.md).

## Verification

Before publishing or deploying this release:

```bash
npm ci
npm test
npm run benchmark:check
npm run pack:dry-run
npm run package:smoke
```

## Upgrade Notes

- Node.js 22 or newer is the supported runtime baseline, including active LTS lines.
- Existing 0.2.x stores remain GraphVault-native object stores; no storage-server migration is required.
- For large stores, prefer configured property indexes over indexing every frequently changing field.
- For shared stores with several application pods, keep using GraphVault transactions as the write boundary and read [transactions and concurrency](./TRANSACTIONS.md).

## Known Boundaries

GraphVault 0.2.3 remains application-owned embedded storage, not a replicated consensus database or SQL-compatible server. It is best deployed behind an application boundary that owns the object model, commit path, migrations, and operational checks.
