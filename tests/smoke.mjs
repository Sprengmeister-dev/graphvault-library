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
  const first = new Document("doc-1", "Object graph persistence", owner);
  const second = new Document("doc-2", "Admin workflows", owner);
  first.views = 10;
  second.views = 15;
  first.tags.add("typescript");
  first.tags.add("storage");
  second.links.set("source", first);
  first.related.push(second);

  const storage = await EmbeddedStorage.start({
    storageDirectory,
    root: { documents: [first, second], featured: first },
    types,
  });

  await storage.storeRoot();
  await storage.shutdown();

  const reloaded = await EmbeddedStorage.start({
    storageDirectory,
    rootFactory: () => ({ documents: [] }),
    types,
  });

  assert.equal(reloaded.root.documents.length, 2);
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

  const aggregate = await reloaded.gvql(`
    MATCH (doc:Document)
    WHERE doc.status = "draft"
    RETURN doc.status AS status, count(*) AS count, count(doc.views) AS viewed, sum(doc.views) AS views, avg(doc.views) AS avgViews
    GROUP BY doc.status
  `);
  assert.equal(aggregate.kind, "select");
  assert.deepEqual(aggregate.rows, [{ status: "draft", count: 2, viewed: 2, views: 25, avgViews: 12.5 }]);
  assert.ok(aggregate.matched <= aggregate.scannedObjects);

  const preview = await reloaded.previewGvql(
    'MATCH (doc:Document) WHERE doc.id = $id SET doc.title = "Admin workflows updated" RETURN doc.id AS id, doc.title AS title',
    { parameters: { id: "doc-2" } },
  );
  assert.equal(preview.kind, "update");
  assert.equal(preview.dryRun, true);
  assert.equal(preview.changes.length, 1);
  assert.equal(reloaded.root.documents[1].title, "Admin workflows");

  const update = await reloaded.gvql(
    'MATCH (doc:Document) WHERE doc.id = $id SET doc.title = "Admin workflows updated" RETURN doc.id AS id, doc.title AS title',
    { parameters: { id: "doc-2" } },
  );
  assert.equal(update.kind, "update");
  assert.equal(update.changed, 1);
  assert.equal(reloaded.root.documents[1].title, "Admin workflows updated");

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
