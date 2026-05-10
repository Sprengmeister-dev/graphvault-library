import { mkdtemp, rm, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { EmbeddedStorage, MemoryStorageTarget } from "../dist/index.js";

const sizes = [100, 300, 750];

class Owner {
  constructor(id, name) {
    this.id = id;
    this.name = name;
  }
}

class Category {
  constructor(slug, label) {
    this.slug = slug;
    this.label = label;
  }
}

class Document {
  constructor(id, title, owner, category, previous) {
    this.id = id;
    this.title = title;
    this.status = id % 7 === 0 ? "review" : id % 5 === 0 ? "archived" : "active";
    this.owner = owner;
    this.category = category;
    this.tags = [`team-${id % 8}`, `topic-${id % 17}`, id % 2 === 0 ? "even" : "odd"];
    this.views = id * 13;
    this.metrics = { views: id * 13, score: (id % 100) / 100 };
    this.createdAt = new Date(1_765_000_000_000 + id * 60_000);
    this.related = previous ? [previous] : [];
  }
}

function createRoot(count) {
  const owners = Array.from({ length: 64 }, (_, index) => new Owner(`owner-${index}`, `Owner ${index}`));
  const categories = Array.from({ length: 24 }, (_, index) => new Category(`cat-${index}`, `Category ${index}`));
  const documents = [];
  const byId = new Map();
  const active = new Set();
  for (let index = 0; index < count; index++) {
    const document = new Document(index, `Document ${index}`, owners[index % owners.length], categories[index % categories.length], documents[index - 1]);
    documents.push(document);
    byId.set(document.id, document);
    if (document.status === "active") {
      active.add(document);
    }
  }
  return {
    generatedAt: new Date("2026-05-10T12:00:00.000Z"),
    owners,
    categories,
    documents,
    byId,
    active,
    featured: documents.slice(0, Math.min(25, documents.length)),
  };
}

function typeRegistrations() {
  return [
    { name: "Owner", ctor: Owner },
    { name: "Category", ctor: Category },
    { name: "Document", ctor: Document },
  ];
}

async function benchmarkMemory(count) {
  const target = new MemoryStorageTarget();
  const directory = `memory-${count}`;
  const root = createRoot(count);
  const storage = await EmbeddedStorage.start({ storageDirectory: directory, storageTarget: target, root, types: typeRegistrations() });
  const store = await time(() => storage.storeRoot());
  const gvql = await time(() =>
    storage.gvql('MATCH (doc:Document)-[:owner]->(owner:Owner) WHERE owner.name = "Owner 1" RETURN doc.id AS id, doc.title AS title LIMIT 25'),
  );
  const gvqlIndexed = await time(() =>
    storage.gvql(
      'MATCH (doc:Document) WHERE doc.status = "active" RETURN doc.status AS status, count(*) AS count, avg(doc.views) AS avgViews GROUP BY doc.status HAVING count > 0 ORDER BY count DESC',
    ),
  );
  await storage.shutdown();
  const load = await time(async () => {
    const loaded = await EmbeddedStorage.start({ storageDirectory: directory, storageTarget: target, rootFactory: () => ({}), types: typeRegistrations() });
    await loaded.shutdown();
  });
  return { target: "memory", count, storeMs: store.ms, gvqlMs: gvql.ms, gvqlIndexedMs: gvqlIndexed.ms, loadMs: load.ms, bytes: undefined };
}

async function benchmarkFilesystem(count) {
  const directory = await mkdtemp(join(tmpdir(), "graphvault-bench-"));
  try {
    const root = createRoot(count);
    const storage = await EmbeddedStorage.start({ storageDirectory: directory, root, types: typeRegistrations() });
    const store = await time(() => storage.storeRoot());
    const gvql = await time(() =>
      storage.gvql('MATCH (doc:Document)-[:owner]->(owner:Owner) WHERE owner.name = "Owner 1" RETURN doc.id AS id, doc.title AS title LIMIT 25'),
    );
    const gvqlIndexed = await time(() =>
      storage.gvql(
        'MATCH (doc:Document) WHERE doc.status = "active" RETURN doc.status AS status, count(*) AS count, avg(doc.views) AS avgViews GROUP BY doc.status HAVING count > 0 ORDER BY count DESC',
      ),
    );
    await storage.shutdown();
    const load = await time(async () => {
      const loaded = await EmbeddedStorage.start({ storageDirectory: directory, rootFactory: () => ({}), types: typeRegistrations() });
      await loaded.shutdown();
    });
    return {
      target: "filesystem",
      count,
      storeMs: store.ms,
      gvqlMs: gvql.ms,
      gvqlIndexedMs: gvqlIndexed.ms,
      loadMs: load.ms,
      bytes: await directorySize(directory),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function time(fn) {
  const started = performance.now();
  await fn();
  return { ms: performance.now() - started };
}

async function directorySize(path) {
  const info = await stat(path);
  if (!info.isDirectory()) {
    return info.size;
  }
  const children = await readdir(path);
  let total = 0;
  for (const child of children) {
    total += await directorySize(join(path, child));
  }
  return total;
}

function formatMs(value) {
  return `${value.toFixed(1)} ms`;
}

function formatBytes(value) {
  if (value === undefined) {
    return "-";
  }
  const mib = value / 1024 / 1024;
  return `${mib.toFixed(2)} MiB`;
}

const rows = [];
for (const count of sizes) {
  rows.push(await benchmarkMemory(count));
  rows.push(await benchmarkFilesystem(count));
}

console.log(`# GraphVault object graph benchmark`);
console.log();
console.log(`Runtime: ${process.version}`);
console.log(`Platform: ${process.platform} ${process.arch}`);
console.log(`Date: ${new Date().toISOString()}`);
console.log();
console.log(`| target | documents | storeRoot | GVQL traversal | GVQL indexed aggregate | reload | storage size |`);
console.log(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
for (const row of rows) {
  console.log(
    `| ${row.target} | ${row.count.toLocaleString("en-US")} | ${formatMs(row.storeMs)} | ${formatMs(row.gvqlMs)} | ${formatMs(row.gvqlIndexedMs)} | ${formatMs(row.loadMs)} | ${formatBytes(row.bytes)} |`,
  );
}
