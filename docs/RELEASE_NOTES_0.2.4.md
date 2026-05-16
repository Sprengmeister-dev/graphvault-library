# GraphVault TS 0.2.4 Release Notes

GraphVault TS 0.2.4 is the professional indexing release. It turns the persistent index sidecar into a modular index subsystem for large GraphVault stores and admin-heavy GVQL workloads.

## Why Upgrade

Use 0.2.4 if you want the current package baseline for real TypeScript and NestJS projects. Compared with 0.2.3, this release adds professional index families, index verification/repair, and planner support for large GraphVault stores.

## What Is New Since 0.2.3

- Professional index families for composite filters, range predicates, text/substring search, full-text token lookup, unique constraints, partial/sparse coverage, and expressions such as `lower(title)`.
- `indexStatus()`, `verifyIndexes()`, `rebuildIndexes()`, and `repairIndexes()` for operational index administration.
- GVQL planning that can reuse committed composite, range, text, full-text, unique, and expression indexes before normal predicate verification.
- Index statistics for operational visibility and future cost-based planning.
- Index format v2, intentionally without legacy compatibility constraints.

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
    composites: [{ name: "tenant_status", paths: ["tenantId", "status"] }],
    ranges: [{ name: "created_at", path: "createdAt" }],
    text: [{ name: "title_substring", path: "title" }],
    fullText: [{ name: "body_tokens", path: "body" }],
    unique: [{ name: "tenant_slug_unique", paths: ["tenantId", "slug"] }],
    expressions: [{ name: "title_lower", expression: { fn: "lower", path: "title" } }],
  },
});
```

For write-heavy embedded stores, add `writeProfile: "maximum"` and keep `transactionLog: "full"` unless the store is disposable.

## Persistent Indexes

GraphVault now keeps a committed index sidecar next to the store manifest. The index contains object type lookups, selected property values, graph-edge information, and configured advanced index families. GVQL uses that sidecar when it matches the committed graph, which lets admin tools and application queries avoid repeatedly scanning the full graph for common predicates.

```ts
const status = await storage.indexStatus();
const verification = await storage.verifyIndexes();

if (!verification.ok) {
  await storage.repairIndexes();
}
```

See [persistent indexes](./INDEXES.md).

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

- Node.js 26 or newer is the supported runtime baseline.
- Existing 0.2.x stores remain GraphVault-native object stores; no storage-server migration is required.
- For large stores, prefer configured property indexes over indexing every frequently changing field.
- For shared stores with several application pods, keep using GraphVault transactions as the write boundary and read [transactions and concurrency](./TRANSACTIONS.md).

## Known Boundaries

GraphVault 0.2.4 remains application-owned embedded storage, not a replicated consensus database or SQL-compatible server. It is best deployed behind an application boundary that owns the object model, commit path, migrations, and operational checks.
