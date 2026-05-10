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

  const metadataQuery = await reloaded.gvql(`
    MATCH (doc:Document)
    RETURN doc.$id AS objectId, doc.$type AS type, doc.$kind AS kind
    ORDER BY doc.$id ASC
    LIMIT 1
  `);
  assert.equal(metadataQuery.kind, "select");
  assert.equal(typeof metadataQuery.rows[0].objectId, "string");
  assert.deepEqual(
    {
      type: metadataQuery.rows[0].type,
      kind: metadataQuery.rows[0].kind,
    },
    { type: "Document", kind: "object" },
  );
  const firstDocumentObjectId = metadataQuery.rows[0].objectId;

  const metadataTypeFilter = await reloaded.gvql(`
    MATCH (node)
    WHERE node.$type IN ["Document"]
    RETURN count(*) AS count
  `);
  assert.equal(metadataTypeFilter.kind, "select");
  assert.deepEqual(metadataTypeFilter.rows, [{ count: 3 }]);
  assert.equal(metadataTypeFilter.plan.candidateSource, "type-index");
  assert.equal(metadataTypeFilter.plan.operations.includes("type-index:Document"), true);

  const metadataIdFilter = await reloaded.gvql(
    `
      MATCH (node)
      WHERE node.$id = $objectId
      RETURN node.$id AS objectId
    `,
    { parameters: { objectId: firstDocumentObjectId } },
  );
  assert.equal(metadataIdFilter.kind, "select");
  assert.deepEqual(metadataIdFilter.rows, [{ objectId: firstDocumentObjectId }]);
  assert.equal(metadataIdFilter.plan.candidateSource, "id-index");

  const distinctCount = await reloaded.gvql(`
    MATCH (doc:Document)
    RETURN count(DISTINCT doc.status) AS statuses
  `);
  assert.equal(distinctCount.kind, "select");
  assert.deepEqual(distinctCount.rows, [{ statuses: 2 }]);

  const distinctTypeCount = await reloaded.gvql(`
    MATCH (node)
    WHERE node.$type IS NOT NULL
    RETURN count(DISTINCT node.$type) AS types
  `);
  assert.equal(distinctTypeCount.kind, "select");
  assert.deepEqual(distinctTypeCount.rows, [{ types: 2 }]);

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

  const wherePrecedence = await reloaded.gvql(`
    MATCH (doc:Document)
    WHERE doc.id = "doc-1" OR doc.status = "published" AND doc.views > 50
    RETURN doc.id AS id
    ORDER BY doc.id ASC
  `);
  assert.equal(wherePrecedence.kind, "select");
  assert.deepEqual(wherePrecedence.rows, [{ id: "doc-1" }, { id: "doc-3" }]);

  const whereParentheses = await reloaded.gvql(`
    MATCH (doc:Document)
    WHERE (doc.id = "doc-1" OR doc.status = "published") AND doc.views > 50
    RETURN doc.id AS id
    ORDER BY doc.id ASC
  `);
  assert.equal(whereParentheses.kind, "select");
  assert.deepEqual(whereParentheses.rows, [{ id: "doc-3" }]);

  const whereNot = await reloaded.gvql(`
    MATCH (doc:Document)
    WHERE NOT (doc.status = "published" OR doc.views < 12)
    RETURN doc.id AS id
    ORDER BY doc.id ASC
  `);
  assert.equal(whereNot.kind, "select");
  assert.deepEqual(whereNot.rows, [{ id: "doc-2" }]);

  const computedReturn = await reloaded.gvql(
    `
      MATCH (doc:Document)
      RETURN doc.id AS id, (doc.views + $bonus) * 2 AS score
      ORDER BY score DESC
      LIMIT 1
    `,
    { parameters: { bonus: 5 } },
  );
  assert.equal(computedReturn.kind, "select");
  assert.deepEqual(computedReturn.rows, [{ id: "doc-3", score: 210 }]);

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

  const havingPrecedence = await reloaded.gvql(`
    MATCH (doc:Document)
    RETURN doc.status AS status, count(*) AS count, avg(doc.views) AS avgViews
    GROUP BY doc.status
    HAVING status = "published" OR count >= 2 AND avgViews < 20
    ORDER BY status ASC
  `);
  assert.equal(havingPrecedence.kind, "select");
  assert.deepEqual(havingPrecedence.rows, [
    { status: "draft", count: 2, avgViews: 12.5 },
    { status: "published", count: 1, avgViews: 100 },
  ]);

  const havingParentheses = await reloaded.gvql(`
    MATCH (doc:Document)
    RETURN doc.status AS status, count(*) AS count, avg(doc.views) AS avgViews
    GROUP BY doc.status
    HAVING (status = "published" OR count >= 2) AND avgViews < 20
    ORDER BY status ASC
  `);
  assert.equal(havingParentheses.kind, "select");
  assert.deepEqual(havingParentheses.rows, [{ status: "draft", count: 2, avgViews: 12.5 }]);

  const havingNot = await reloaded.gvql(`
    MATCH (doc:Document)
    RETURN doc.status AS status, count(*) AS count, avg(doc.views) AS avgViews
    GROUP BY doc.status
    HAVING NOT (status = "published" OR avgViews < 10)
    ORDER BY status ASC
  `);
  assert.equal(havingNot.kind, "select");
  assert.deepEqual(havingNot.rows, [{ status: "draft", count: 2, avgViews: 12.5 }]);

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
  assert.equal(disjunction.plan.candidateSource, "property-index");
  assert.equal(disjunction.plan.startCandidates, 1);
  assert.equal(disjunction.plan.operations.includes("index-or-union:2"), true);

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

  const arithmeticPreview = await reloaded.previewGvql(
    "MATCH (doc:Document) WHERE doc.id = $id SET doc.views = (doc.views + $increment) * 2 RETURN doc.id AS id, doc.views AS views",
    { parameters: { id: "doc-2", increment: 5 } },
  );
  assert.equal(arithmeticPreview.kind, "update");
  assert.equal(arithmeticPreview.dryRun, true);
  assert.equal(arithmeticPreview.changed, 1);
  assert.equal(arithmeticPreview.changes[0].before, 15);
  assert.equal(arithmeticPreview.changes[0].after, 40);
  assert.equal(reloaded.root.documents[1].views, 15);

  const arithmeticUpdate = await reloaded.gvql(
    "MATCH (doc:Document) WHERE doc.id = $id SET doc.views = (doc.views + $increment) * 2 RETURN doc.id AS id, doc.views AS views",
    { parameters: { id: "doc-2", increment: 5 } },
  );
  assert.equal(arithmeticUpdate.kind, "update");
  assert.equal(arithmeticUpdate.changed, 1);
  assert.equal(reloaded.root.documents[1].views, 40);

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

  const deletePreview = await reloaded.previewGvql('MATCH (doc:Document) WHERE doc.id = "doc-2" DELETE doc RETURN doc.id AS id');
  assert.equal(deletePreview.kind, "update");
  assert.equal(deletePreview.dryRun, true);
  assert.deepEqual(deletePreview.rows, [{ id: "doc-2" }]);
  assert.equal(deletePreview.changes.some((change) => change.operation === "delete" && change.alias === "doc"), true);
  assert.equal(deletePreview.changes.filter((change) => change.operation === "detach").length, 2);
  assert.equal(reloaded.root.documents.length, 3);
  assert.equal(reloaded.root.documents[0].related.length, 1);

  const deleted = await reloaded.gvql('MATCH (doc:Document) WHERE doc.id = "doc-2" DELETE doc RETURN doc.id AS id');
  assert.equal(deleted.kind, "update");
  assert.deepEqual(deleted.rows, [{ id: "doc-2" }]);
  assert.equal(reloaded.root.documents.length, 2);
  assert.deepEqual(reloaded.root.documents.map((doc) => doc.id), ["doc-1", "doc-3"]);
  assert.equal(reloaded.root.documents[0].related.length, 0);
  assert.equal(deleted.changes.some((change) => change.operation === "delete" && change.alias === "doc"), true);

  const deletedQuery = await reloaded.gvql('MATCH (doc:Document) WHERE doc.id = "doc-2" RETURN doc.id AS id');
  assert.equal(deletedQuery.kind, "select");
  assert.deepEqual(deletedQuery.rows, []);

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
