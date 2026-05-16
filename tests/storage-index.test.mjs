import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddedStorage } from "../dist/index.js";

const directory = await mkdtemp(join(tmpdir(), "graphvault-index-"));
const configuredDirectory = await mkdtemp(join(tmpdir(), "graphvault-configured-index-"));
const advancedDirectory = await mkdtemp(join(tmpdir(), "graphvault-advanced-index-"));
const uniqueDirectory = await mkdtemp(join(tmpdir(), "graphvault-unique-index-"));

try {
  const storage = await EmbeddedStorage.start({
    storageDirectory: directory,
    rootFactory: () => ({
      items: [
        { sku: "A-1", category: "hardware", stock: 8 },
        { sku: "B-2", category: "software", stock: 3 },
      ],
    }),
    indexes: true,
  });
  await storage.storeRoot();

  const indexRecord = JSON.parse(await readFile(join(directory, "index.json"), "utf8"));
  assert.equal(indexRecord.format, "graphvault-index");
  assert.equal(indexRecord.transactionId, 1);
  assert.equal(indexRecord.nodeCount >= 3, true);
  assert.equal(Object.keys(indexRecord.byProperty).some((key) => key.includes("\u0000sku\u0000")), true);

  const indexedResult = await storage.gvql('MATCH (item) WHERE item.sku = "A-1" RETURN item.sku AS sku, item.stock AS stock');
  assert.equal(indexedResult.plan.indexSource, "persistent");
  assert.equal(indexedResult.plan.candidateSource, "property-index");
  assert.equal(indexedResult.rows[0].sku, "A-1");
  assert.equal(indexedResult.rows[0].stock, 8);

  const status = await storage.indexStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.source, "storage");
  assert.equal(status.transactionId, 1);
  assert.equal(status.propertyKeys > 0, true);
  await storage.shutdown();

  const reloaded = await EmbeddedStorage.start({
    storageDirectory: directory,
    rootFactory: () => ({ items: [] }),
    readOnly: true,
  });
  const reloadedResult = await reloaded.gvql('MATCH (item) WHERE item.sku = "B-2" RETURN item.category AS category');
  assert.equal(reloadedResult.plan.indexSource, "persistent");
  assert.equal(reloadedResult.rows[0].category, "software");
  await reloaded.shutdown();

  const configured = await EmbeddedStorage.start({
    storageDirectory: configuredDirectory,
    rootFactory: () => ({
      items: [
        { sku: "A-1", category: "hardware" },
        { sku: "B-2", category: "software" },
      ],
    }),
    indexes: {
      mode: "configured",
      properties: ["sku"],
    },
  });
  await configured.storeRoot();

  const configuredIndex = JSON.parse(await readFile(join(configuredDirectory, "index.json"), "utf8"));
  assert.equal(configuredIndex.mode, "configured");
  assert.equal(Object.keys(configuredIndex.byProperty).some((key) => key.includes("\u0000sku\u0000")), true);
  assert.equal(Object.keys(configuredIndex.byProperty).some((key) => key.includes("\u0000category\u0000")), false);

  const configuredHit = await configured.gvql('MATCH (item) WHERE item.sku = "A-1" RETURN item.category AS category');
  assert.equal(configuredHit.plan.indexSource, "persistent");
  assert.equal(configuredHit.plan.candidateSource, "property-index");
  assert.equal(configuredHit.rows[0].category, "hardware");

  const configuredMiss = await configured.gvql('MATCH (item) WHERE item.category = "software" RETURN item.sku AS sku');
  assert.equal(configuredMiss.plan.indexSource, "persistent");
  assert.equal(configuredMiss.plan.candidateSource, "full-scan");
  assert.equal(configuredMiss.rows[0].sku, "B-2");

  configured.root.items.push({ sku: "C-3", category: "services" });
  await configured.storeRoot();
  const rebuilt = await configured.rebuildIndexes();
  assert.equal(rebuilt.source, "storage");
  assert.equal(rebuilt.transactionId, 2);
  const afterRebuild = await configured.gvql('MATCH (item) WHERE item.sku = "C-3" RETURN item.category AS category');
  assert.equal(afterRebuild.plan.indexSource, "persistent");
  assert.equal(afterRebuild.rows[0].category, "services");
  await configured.shutdown();

  const advanced = await EmbeddedStorage.start({
    storageDirectory: advancedDirectory,
    rootFactory: () => ({
      docs: [
        { tenantId: "t1", slug: "alpha", status: "open", title: "GraphVault indexing", body: "fast object graph search", views: 120, archived: false },
        { tenantId: "t1", slug: "beta", status: "closed", title: "Storage notes", body: "write ahead log durability", views: 40, archived: false },
        { tenantId: "t2", slug: "alpha", status: "open", title: "Planner internals", body: "query planner index choices", views: 220, archived: false },
        { tenantId: "t2", slug: "old", status: "open", title: "Archived draft", body: "old hidden document", views: 5, archived: true },
      ],
    }),
    indexes: {
      mode: "configured",
      composites: [{ name: "tenant_status", paths: ["tenantId", "status"], partial: { path: "archived", value: false } }],
      ranges: [{ name: "views_range", path: "views", partial: { path: "archived", value: false } }],
      text: [{ name: "title_text", path: "title", minGram: 2, maxGram: 3 }],
      fullText: [{ name: "body_tokens", path: "body" }],
      unique: [{ name: "tenant_slug_unique", paths: ["tenantId", "slug"] }],
      expressions: [{ name: "title_lower", expression: { fn: "lower", path: "title" } }],
    },
  });
  await advanced.storeRoot();

  const advancedIndex = JSON.parse(await readFile(join(advancedDirectory, "index.json"), "utf8"));
  assert.equal(advancedIndex.version, 2);
  assert.equal(advancedIndex.advanced.definitions.length, 6);
  assert.equal(Object.keys(advancedIndex.advanced.composite.tenant_status).length > 0, true);
  assert.equal(advancedIndex.advanced.range.views_range.length, 3);
  assert.equal(Object.keys(advancedIndex.advanced.text.title_text).some((term) => term.startsWith("gram:")), true);

  const composite = await advanced.gvql(`
    MATCH (doc)
    WHERE doc.tenantId = "t1" AND doc.status = "open"
    RETURN doc.slug AS slug
  `);
  assert.equal(composite.plan.candidateSource, "composite-index");
  assert.deepEqual(composite.rows, [{ slug: "alpha" }]);

  const range = await advanced.gvql(`
    MATCH (doc)
    WHERE doc.views >= 100
    RETURN doc.slug AS slug
    ORDER BY doc.slug ASC
  `);
  assert.equal(range.plan.candidateSource, "range-index");
  assert.deepEqual(range.rows, [{ slug: "alpha" }, { slug: "alpha" }]);

  const text = await advanced.gvql(`
    MATCH (doc)
    WHERE doc.title CONTAINS "Vault"
    RETURN doc.slug AS slug
  `);
  assert.equal(text.plan.candidateSource, "text-index");
  assert.deepEqual(text.rows, [{ slug: "alpha" }]);

  const fullText = await advanced.gvql(`
    MATCH (doc)
    WHERE doc.body CONTAINS "planner"
    RETURN doc.title AS title
  `);
  assert.equal(fullText.plan.candidateSource, "fulltext-index");
  assert.deepEqual(fullText.rows, [{ title: "Planner internals" }]);

  const expression = await advanced.gvql(`
    MATCH (doc)
    WHERE lower(doc.title) = "storage notes"
    RETURN doc.slug AS slug
  `);
  assert.equal(expression.plan.candidateSource, "expression-index");
  assert.deepEqual(expression.rows, [{ slug: "beta" }]);

  const advancedStatus = await advanced.indexStatus();
  assert.equal(advancedStatus.advancedIndexes, 6);
  assert.equal((advancedStatus.compositeKeys ?? 0) > 0, true);
  assert.equal((advancedStatus.textTerms ?? 0) > 0, true);
  assert.equal((await advanced.verifyIndexes()).ok, true);
  await advanced.shutdown();

  const duplicate = await EmbeddedStorage.start({
    storageDirectory: uniqueDirectory,
    rootFactory: () => ({ docs: [{ tenantId: "t1", slug: "same" }, { tenantId: "t1", slug: "same" }] }),
    indexes: {
      mode: "configured",
      unique: [{ name: "tenant_slug_unique", paths: ["tenantId", "slug"] }],
    },
  });
  await assert.rejects(() => duplicate.storeRoot(), /Unique GraphVault index/);
  await duplicate.shutdown();
} finally {
  await rm(directory, { recursive: true, force: true });
  await rm(configuredDirectory, { recursive: true, force: true });
  await rm(advancedDirectory, { recursive: true, force: true });
  await rm(uniqueDirectory, { recursive: true, force: true });
}
