# Persistent Indexes

GraphVault writes a persistent `index.json` sidecar next to the manifest. It contains type, property, graph-edge, composite, range, text, full-text, expression, and unique lookup tables for the current committed transaction. GVQL can reuse this index instead of rebuilding candidate maps for every query.

## Default

Indexes are enabled by default:

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  rootFactory: () => ({ documents: [] }),
});
```

The default mode, `auto`, indexes all direct object properties plus type and reference edges. This is the easiest production setting and is usually the right choice for admin tools and read-heavy services.

## Configured Property Indexes

For very large graphs, index only the fields that matter for common filters:

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  rootFactory: () => ({ documents: [] }),
  indexes: {
    mode: "configured",
    properties: [
      "id",
      "status",
      { type: "Invoice", path: "customerId" },
    ],
  },
});
```

GVQL still stays correct if a query filters on an unconfigured property. The planner falls back to a full candidate scan for that predicate and then applies the normal `WHERE` filter.

## Professional Index Families

Use advanced index families when a store has stable query patterns and large object counts:

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  rootFactory: () => ({ docs: [] }),
  indexes: {
    mode: "configured",
    composites: [
      { name: "tenant_status", paths: ["tenantId", "status"] },
    ],
    ranges: [
      { name: "created_at", path: "createdAt" },
      { name: "views", path: "views", partial: { path: "archived", value: false } },
    ],
    text: [
      { name: "title_substring", path: "title", minGram: 2, maxGram: 4 },
    ],
    fullText: [
      { name: "body_tokens", path: "body" },
    ],
    unique: [
      { name: "tenant_slug_unique", paths: ["tenantId", "slug"] },
    ],
    expressions: [
      { name: "title_lower", expression: { fn: "lower", path: "title" } },
    ],
  },
});
```

### Composite Indexes

Composite indexes accelerate equality filters across several fields:

```gvql
MATCH (doc)
WHERE doc.tenantId = "t1" AND doc.status = "open"
RETURN doc.id
```

This uses `tenant_status` directly instead of intersecting separate property indexes. Composite indexes can also be marked `unique: true`.

### Range Indexes

Range indexes accelerate numeric and string/date-like comparisons:

```gvql
MATCH (doc)
WHERE doc.createdAt >= "2026-01-01"
RETURN doc.id
```

The current range index stores ordered value buckets inside the committed sidecar. It is optimized for reducing candidates before normal GVQL predicate evaluation; GraphVault still applies the `WHERE` clause afterward for correctness.

### Text And Substring Indexes

Text indexes support `CONTAINS`, `STARTS WITH`, and `ENDS WITH` on configured string fields:

```gvql
MATCH (doc)
WHERE doc.title CONTAINS "vault"
RETURN doc.id
```

GraphVault stores prefix, suffix, token, and n-gram terms. `caseSensitive` defaults to `false`, `minGram` defaults to `2`, and `maxGram` defaults to `4`.

### Full-Text Token Indexes

Full-text indexes tokenize configured fields and intersect query tokens:

```gvql
MATCH (doc)
WHERE doc.body CONTAINS "planner"
RETURN doc.id
```

This is intentionally simple and deterministic: token lookup first, normal GVQL predicate evaluation second. Ranking, stemming, language analyzers, and fuzzy search are future extensions.

### Unique, Partial, Sparse, And Expression Indexes

Unique indexes reject duplicate values during commit:

```ts
unique: [{ name: "tenant_slug_unique", paths: ["tenantId", "slug"] }]
```

Partial indexes only include objects matching a simple condition:

```ts
ranges: [{ name: "active_views", path: "views", partial: { path: "archived", value: false } }]
```

Sparse indexes skip objects where one of the indexed values is `null` or `undefined`.

Expression indexes currently support `lower(path)`, `upper(path)`, `trim(path)`, and `length(path)`:

```ts
expressions: [
  { name: "normalized_title", expression: { fn: "lower", path: "title" } },
]
```

```gvql
MATCH (doc)
WHERE lower(doc.title) = "release notes"
RETURN doc.id
```

## Consistency Mode

`consistency: "strict"` is the default. GraphVault only reuses the persistent index when a stable SHA-256 hash of the current root/nodes matches the indexed transaction. This protects correctness if application code mutates the in-memory root before committing.

`consistency: "committed"` skips that hash check for read queries and assumes callers query the last committed graph. Mutating GVQL statements still require strict matching.

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  rootFactory: () => ({ documents: [] }),
  indexes: {
    mode: "auto",
    consistency: "committed",
  },
});
```

Use committed consistency only when your app treats GraphVault as an explicit committed-store API and does not run read queries over uncommitted root mutations.

## Operations

```ts
const status = await storage.indexStatus();
const verification = await storage.verifyIndexes();
await storage.rebuildIndexes();
await storage.repairIndexes();
```

`indexStatus()` reports whether indexes are enabled, the mode, consistency, transaction id, node count, property-key count, edge count, advanced index count, composite/range/text/full-text/expression/unique key counts, and whether the sidecar is loaded, missing, stale, or disabled.

`verifyIndexes()` rebuilds the expected index for the loaded root and compares it with the persistent sidecar, ignoring only volatile creation timestamps.

`rebuildIndexes()` takes the writer lock and rewrites `index.json` for the currently loaded root. `repairIndexes()` is an explicit alias for operational tooling.

## Write Path

On every commit GraphVault writes object records and WAL first, then publishes transaction metadata, parent index, persistent index, `CURRENT`, and finally `manifest.json`. Because the manifest is published last, a failed index write does not advance the committed store.
