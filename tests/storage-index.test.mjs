import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddedStorage } from "../dist/index.js";

const directory = await mkdtemp(join(tmpdir(), "graphvault-index-"));
const configuredDirectory = await mkdtemp(join(tmpdir(), "graphvault-configured-index-"));

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
} finally {
  await rm(directory, { recursive: true, force: true });
  await rm(configuredDirectory, { recursive: true, force: true });
}
