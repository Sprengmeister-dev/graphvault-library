import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EmbeddedStorage, GRAPHVAULT_MANAGER, GraphVaultModule, StorageManager } from "../dist/index.js";

class Owner {
  constructor(id, name) {
    this.id = id;
    this.name = name;
  }
}

class Document {
  constructor(id, title, owner) {
    this.id = id;
    this.title = title;
    this.owner = owner;
    this.status = "draft";
    this.views = 0;
    this.tags = new Set();
    this.links = new Map();
    this.related = [];
  }
}

const types = [
  { name: "Owner", ctor: Owner },
  { name: "Document", ctor: Document },
];

const storageDirectory = await mkdtemp(join(tmpdir(), "graphvault-smoke-"));

try {
  const owner = new Owner("owner-1", "Platform Team");
  const archiveOwner = new Owner("owner-2", "Archive Team");
  const first = new Document("doc-1", "Object graph persistence", owner);
  const second = new Document("doc-2", "Admin workflows", owner);
  const third = new Document("doc-3", "Long-term archive", archiveOwner);
  first.views = 10;
  second.views = 15;
  second.archivedAt = "2026-05-10";
  third.status = "published";
  third.views = 100;
  first.tags.add("typescript");
  first.tags.add("storage");
  second.links.set("source", first);
  first.related.push(second);

  const storage = await EmbeddedStorage.start({
    storageDirectory,
    root: { documents: [first, second, third], featured: first },
    types,
  });

  await storage.storeRoot();
  await storage.shutdown();

  const reloaded = await EmbeddedStorage.start({
    storageDirectory,
    rootFactory: () => ({ documents: [] }),
    types,
  });

  assert.equal(reloaded.root.documents.length, 3);
  assert.ok(reloaded.root.documents[0] instanceof Document);
  assert.ok(reloaded.root.documents[1] instanceof Document);
  assert.ok(reloaded.root.documents[0].owner instanceof Owner);
  assert.equal(reloaded.root.documents[0].owner, reloaded.root.documents[1].owner);
  assert.equal(reloaded.root.featured, reloaded.root.documents[0]);
  assert.equal(reloaded.root.documents[1].links.get("source"), reloaded.root.documents[0]);
  assert.equal(reloaded.root.documents[0].related[0], reloaded.root.documents[1]);
  assert.ok(reloaded.root.documents[0].tags.has("typescript"));

  const query = await reloaded.gvql(`
    MATCH (doc:Document)-[:owner]->(owner:Owner)
    WHERE owner.name = "Platform Team"
    RETURN doc.id AS id, doc.title AS title
    ORDER BY doc.id ASC
    LIMIT 5
  `);
  assert.equal(query.kind, "select");
  assert.deepEqual(query.rows, [
    { id: "doc-1", title: "Object graph persistence" },
    { id: "doc-2", title: "Admin workflows" },
  ]);
  assert.equal(query.plan.candidateSource, "type-index");
  assert.equal(query.plan.edgeSteps, 1);
  assert.equal(query.plan.returnedRows, 2);

  const paged = await reloaded.gvql(`
    MATCH (doc:Document)
    RETURN doc.id AS id
    ORDER BY doc.id ASC
    LIMIT 1
    OFFSET 1
  `);
  assert.equal(paged.kind, "select");
  assert.deepEqual(paged.rows, [{ id: "doc-2" }]);
  assert.equal(paged.plan.limit, 1);
  assert.equal(paged.plan.offset, 1);
  assert.equal(paged.plan.operations.includes("project-window"), true);

  const distinct = await reloaded.gvql(`
    MATCH (doc:Document)
    RETURN DISTINCT doc.status AS status
    ORDER BY status ASC
  `);
  assert.equal(distinct.kind, "select");
  assert.deepEqual(distinct.rows, [{ status: "draft" }, { status: "published" }]);
  assert.equal(distinct.statement.distinct, true);
  assert.equal(distinct.plan.distinct, true);
  assert.equal(distinct.plan.operations.includes("distinct"), true);

  const multiOrder = await reloaded.gvql(`
    MATCH (doc:Document)
    RETURN doc.id AS id, doc.status AS status
    ORDER BY doc.status ASC, doc.id DESC
  `);
  assert.equal(multiOrder.kind, "select");
  assert.deepEqual(multiOrder.rows, [
    { id: "doc-2", status: "draft" },
    { id: "doc-1", status: "draft" },
    { id: "doc-3", status: "published" },
  ]);

  const nullFilter = await reloaded.gvql(`
    MATCH (doc:Document)
    WHERE doc.archivedAt IS NULL AND doc.status IS NOT NULL
    RETURN doc.id AS id
    ORDER BY doc.id ASC
    LIMIT 2
  `);
  assert.equal(nullFilter.kind, "select");
  assert.deepEqual(nullFilter.rows, [{ id: "doc-1" }, { id: "doc-3" }]);

  const aggregate = await reloaded.gvql(`
    MATCH (doc:Document)
    RETURN doc.status AS status, count(*) AS count, count(doc.views) AS viewed, sum(doc.views) AS views, avg(doc.views) AS avgViews
    GROUP BY doc.status
    HAVING count >= 1 AND status IS NOT NULL
    ORDER BY avgViews DESC
  `);
  assert.equal(aggregate.kind, "select");
  assert.deepEqual(aggregate.rows, [
    { status: "published", count: 1, viewed: 1, views: 100, avgViews: 100 },
    { status: "draft", count: 2, viewed: 2, views: 25, avgViews: 12.5 },
  ]);
  assert.ok(aggregate.matched <= aggregate.scannedObjects);
  assert.equal(aggregate.plan.grouped, true);
  assert.equal(aggregate.plan.having, true);
  assert.equal(aggregate.plan.returnedRows, 2);

  const having = await reloaded.gvql(
    `
      MATCH (doc:Document)
      RETURN doc.status AS status, count(*) AS count
      GROUP BY doc.status
      HAVING count >= $minimum
      ORDER BY count DESC
    `,
    { parameters: { minimum: 2 } },
  );
  assert.equal(having.kind, "select");
  assert.deepEqual(having.rows, [{ status: "draft", count: 2 }]);
  assert.equal(having.plan.operations.includes("having-filter"), true);

  const indexed = await reloaded.gvql('MATCH (doc:Document) WHERE doc.id = $id RETURN doc.id AS id', { parameters: { id: "doc-2" } });
  assert.equal(indexed.kind, "select");
  assert.deepEqual(indexed.rows, [{ id: "doc-2" }]);
  assert.equal(indexed.plan.candidateSource, "property-index");
  assert.equal(indexed.plan.indexUsed, true);
  assert.equal(indexed.plan.propertyIndex.path, "id");
  assert.equal(indexed.plan.startCandidates, 1);

  const indexedIntersection = await reloaded.gvql(
    'MATCH (doc:Document) WHERE doc.status = "draft" AND doc.id = $id RETURN doc.id AS id',
    { parameters: { id: "doc-2" } },
  );
  assert.equal(indexedIntersection.kind, "select");
  assert.deepEqual(indexedIntersection.rows, [{ id: "doc-2" }]);
  assert.equal(indexedIntersection.plan.candidateSource, "property-index");
  assert.equal(indexedIntersection.plan.propertyIndexes.length, 2);
  assert.equal(indexedIntersection.plan.operations.includes("property-index-intersect:2"), true);

  const indexedIn = await reloaded.gvql(`
    MATCH (doc:Document)
    WHERE doc.status IN ["draft", "published"] AND doc.id IN ["doc-1", "doc-3"]
    RETURN doc.id AS id
    ORDER BY doc.id ASC
  `);
  assert.equal(indexedIn.kind, "select");
  assert.deepEqual(indexedIn.rows, [{ id: "doc-1" }, { id: "doc-3" }]);
  assert.equal(indexedIn.plan.candidateSource, "property-index");
  assert.equal(indexedIn.plan.propertyIndexes.length, 4);
  assert.equal(indexedIn.plan.operations.includes("property-index-union:status:2"), true);
  assert.equal(indexedIn.plan.operations.includes("property-index-union:id:2"), true);
  assert.equal(indexedIn.plan.operations.includes("property-index-intersect:2"), true);

  const disjunction = await reloaded.gvql(`
    MATCH (doc:Document)
    WHERE doc.id = "missing" OR doc.status = "published"
    RETURN doc.id AS id
  `);
  assert.equal(disjunction.kind, "select");
  assert.deepEqual(disjunction.rows, [{ id: "doc-3" }]);
  assert.equal(disjunction.plan.candidateSource, "type-index");

  const preview = await reloaded.previewGvql(
    'MATCH (doc:Document) WHERE doc.id = $id SET doc.title = "Admin workflows updated" RETURN doc.id AS id, doc.title AS title',
    { parameters: { id: "doc-2" } },
  );
  assert.equal(preview.kind, "update");
  assert.equal(preview.dryRun, true);
  assert.equal(preview.changes.length, 1);
  assert.equal(preview.plan.candidateSource, "property-index");
  assert.equal(reloaded.root.documents[1].title, "Admin workflows");

  const update = await reloaded.gvql(
    'MATCH (doc:Document) WHERE doc.id = $id SET doc.title = "Admin workflows updated" RETURN doc.id AS id, doc.title AS title',
    { parameters: { id: "doc-2" } },
  );
  assert.equal(update.kind, "update");
  assert.equal(update.changed, 1);
  assert.equal(reloaded.root.documents[1].title, "Admin workflows updated");

  const removePreview = await reloaded.previewGvql('MATCH (doc:Document) WHERE doc.id = $id REMOVE doc.archivedAt RETURN doc.id AS id', {
    parameters: { id: "doc-2" },
  });
  assert.equal(removePreview.kind, "update");
  assert.equal(removePreview.dryRun, true);
  assert.equal(removePreview.changed, 1);
  assert.equal(removePreview.changes[0].before, "2026-05-10");
  assert.equal(removePreview.changes[0].after, undefined);
  assert.equal(reloaded.root.documents[1].archivedAt, "2026-05-10");

  const remove = await reloaded.gvql('MATCH (doc:Document) WHERE doc.id = $id REMOVE doc.archivedAt RETURN doc.id AS id', {
    parameters: { id: "doc-2" },
  });
  assert.equal(remove.kind, "update");
  assert.equal(remove.changed, 1);
  assert.equal(reloaded.root.documents[1].archivedAt, undefined);

  const removedFieldQuery = await reloaded.gvql('MATCH (doc:Document) WHERE doc.archivedAt IS NULL AND doc.id = "doc-2" RETURN doc.id AS id');
  assert.equal(removedFieldQuery.kind, "select");
  assert.deepEqual(removedFieldQuery.rows, [{ id: "doc-2" }]);

  const verification = await reloaded.verify();
  assert.equal(verification.ok, true);
  await reloaded.shutdown();

  const nestModule = GraphVaultModule.forRoot({
    storageDirectory,
    rootFactory: () => ({ documents: [] }),
  });
  assert.equal(nestModule.exports.includes(GRAPHVAULT_MANAGER), true);
  assert.equal(nestModule.exports.includes(StorageManager), true);
  assert.equal(nestModule.providers.some((provider) => provider.provide === StorageManager && provider.useExisting === GRAPHVAULT_MANAGER), true);
} finally {
  await rm(storageDirectory, { recursive: true, force: true });
}
