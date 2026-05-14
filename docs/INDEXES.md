# Persistent Indexes

GraphVault writes a persistent `index.json` sidecar next to the manifest. It contains type, property, and graph-edge lookup tables for the current committed transaction. GVQL can reuse this index instead of rebuilding candidate maps for every query.

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
await storage.rebuildIndexes();
```

`indexStatus()` reports whether indexes are enabled, the mode, consistency, transaction id, node count, property-key count, edge count, and whether the sidecar is loaded, missing, stale, or disabled.

`rebuildIndexes()` takes the writer lock and rewrites `index.json` for the currently loaded root. It is useful after changing index configuration or repairing older stores.

## Write Path

On every commit GraphVault writes object records and WAL first, then publishes transaction metadata, parent index, persistent index, `CURRENT`, and finally `manifest.json`. Because the manifest is published last, a failed index write does not advance the committed store.
