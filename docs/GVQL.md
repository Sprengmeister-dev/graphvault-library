# GVQL Guide

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

Join multiple graph patterns by reusing aliases in the same `MATCH` clause:

```ts
const joined = await storage.gvql(`
  MATCH (doc:Document)-[:owner]->(owner:Owner), (doc)-[:category]->(category:Category)
  WHERE owner.name = $owner AND category.slug = $category
  RETURN doc.id AS id, doc.title AS title, category.label AS category
  ORDER BY doc.title ASC
`, {
  parameters: { owner: "Platform Team", category: "guides" },
});
```

Use `OPTIONAL MATCH` when a relationship may be missing but the primary row should remain visible:

```ts
const withOptionalLinks = await storage.gvql(`
  MATCH (doc:Document)
  OPTIONAL MATCH (doc)-[:related]->(items)-[:*]->(related:Document)
  RETURN doc.id AS id, related.id AS relatedId
  ORDER BY doc.id ASC
`);
```

Normalize values inline with scalar functions in `WHERE`, `RETURN`, `SET`, and `CREATE` expressions, and use `CASE` for conditional projections or batch updates:

```ts
const normalized = await storage.gvql(`
  MATCH (doc:Document)
  WHERE lower(doc.title) CONTAINS lower($needle)
  RETURN doc.id AS id, upper(trim(doc.title)) AS title, length(doc.title) AS titleLength, coalesce(doc.archivedAt, "none") AS archived
`, {
  parameters: { needle: "storage" },
});

const buckets = await storage.gvql(`
  MATCH (doc:Document)
  RETURN doc.id AS id,
    CASE
      WHEN doc.views >= 1000 THEN "hot"
      WHEN doc.archivedAt IS NOT NULL THEN "archived"
      ELSE "active"
    END AS bucket
`);

const withPipeline = await storage.gvql(`
  MATCH (doc:Document)
  WITH doc.status AS status, count(*) AS count, avg(doc.views) AS avgViews
  GROUP BY doc.status
  HAVING count > 0
  RETURN status, count, avgViews
  ORDER BY count DESC
`);
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

Create new typed objects and attach them to an existing collection in one previewable statement:

```ts
const createPreview = await storage.previewGvql(`
  MATCH (workspace:Workspace)
  WHERE workspace.name = "Developer docs"
  CREATE (doc:Document { id: "doc-4", title: "Release checklist", status: "draft", views: 0 }) INTO workspace.documents
  RETURN doc.id AS id, doc.title AS title
`);
```

`CREATE ... INTO` requires an array or set target, so the new object is reachable from the root graph immediately.

Use `MERGE ... INTO ... ON alias.field` for idempotent imports. Existing objects in the target collection are bound and returned; missing objects are created and attached:

```ts
const importPreview = await storage.previewGvql(`
  MATCH (workspace:Workspace)
  WHERE workspace.name = "Developer docs"
  MERGE (doc:Document { id: "doc-4", title: "Release checklist", status: "draft", views: 0 }) INTO workspace.documents ON doc.id
  RETURN doc.id AS id, doc.title AS title
`);
```

Current GVQL supports:

- node patterns: `(doc:Document)` or `(node)`
- reference traversal: `-[:owner]->` and inverse traversal: `<-[:owner]-`
- multiple comma-separated `MATCH` patterns where shared aliases act as join keys
- `OPTIONAL MATCH` for left-join style relationship expansion
- `WHERE` predicates with `=`, `!=`, `<`, `<=`, `>`, `>=`, `CONTAINS`, `STARTS WITH`, `ENDS WITH`, `IN`, `IS NULL`, `IS NOT NULL`, `AND`, `OR`, `NOT`, and parentheses
- `$parameters`
- `WITH` pipelines for named intermediate rows, aggregate stages, and row-level filters before the final `RETURN`
- `RETURN`, `RETURN DISTINCT`, aliases with `AS`, arithmetic computed expressions such as `(doc.views + $bonus) * 2 AS score`, conditional `CASE WHEN ... THEN ... ELSE ... END` expressions, scalar functions `lower`, `upper`, `trim`, `length`, `coalesce`, `count(*)`, `count(DISTINCT path)`, and virtual metadata paths `$id`, `$type`, `$kind`
- `GROUP BY` with `count`, `sum`, `avg`, `min`, `max`
- `HAVING` over returned aliases for aggregate filtering, with `AND`, `OR`, `NOT`, and parentheses
- `ORDER BY` paths and returned aliases, with multiple criteria plus `LIMIT` and `OFFSET`
- `CREATE (alias:Type { ... }) INTO parent.collection`, `MERGE (alias:Type { ... }) INTO parent.collection ON alias.field` for idempotent collection upserts, `SET` for primitive field updates, arithmetic and `CASE`-based `SET` expressions, `REMOVE` for object-field cleanup, and parent-aware `DELETE alias`
- type indexes, primitive-property index intersections, indexed `IN` unions, and indexed `OR` unions for common filters on the first matched node
- indexed virtual metadata filters for `$id` and `$type`
- persistent storage indexes for committed graphs, with full-scan fallback when a configured property index is unavailable

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
console.log(result.plan.indexSource); // "persistent" or "ephemeral"
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
