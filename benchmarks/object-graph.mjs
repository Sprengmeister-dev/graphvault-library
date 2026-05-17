import { mkdtemp, rm, stat, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { EmbeddedStorage, MemoryStorageTarget } from "../dist/index.js";

const defaultSizes = [100, 300, 750];
const allTargets = ["memory", "filesystem/production", "filesystem/inspect"];
const performanceBudgets = {
  memory: { storeMs: 250, loadMs: 150, gvqlIndexedMs: 100 },
  "filesystem/production": { storeMs: 1_500, loadMs: 500, gvqlIndexedMs: 150 },
  "filesystem/inspect": { storeMs: 8_000, loadMs: 500, gvqlIndexedMs: 150 },
};

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
  const gvqlMultiMatch = await time(() =>
    storage.gvql(
      'MATCH (doc:Document)-[:owner]->(owner:Owner), (doc)-[:category]->(category:Category) WHERE owner.name = "Owner 1" AND category.slug = "cat-1" RETURN doc.id AS id, category.label AS category LIMIT 25',
    ),
  );
  const gvqlOptionalMatch = await time(() =>
    storage.gvql(
      'MATCH (doc:Document) OPTIONAL MATCH (doc)-[:related]->(items)-[:*]->(related:Document) RETURN doc.id AS id, related.id AS relatedId ORDER BY doc.id ASC LIMIT 25',
    ),
  );
  const gvqlIndexed = await time(() =>
    storage.gvql(
      'MATCH (doc:Document) WHERE doc.status = "active" RETURN doc.status AS status, count(*) AS count, avg(doc.views) AS avgViews GROUP BY doc.status HAVING count > 0 ORDER BY count DESC',
    ),
  );
  const gvqlMultiIndex = await time(() =>
    storage.gvql('MATCH (doc:Document) WHERE doc.status = "active" AND doc.id = 1 RETURN doc.id AS id, doc.title AS title'),
  );
  const gvqlIndexedIn = await time(() =>
    storage.gvql('MATCH (doc:Document) WHERE doc.status IN ["active", "review"] AND doc.id IN [1, 7, 14, 21] RETURN doc.id AS id ORDER BY doc.id ASC'),
  );
  const gvqlIndexedOr = await time(() =>
    storage.gvql('MATCH (doc:Document) WHERE doc.id = 1 OR doc.status = "review" RETURN doc.id AS id ORDER BY doc.id ASC LIMIT 25'),
  );
  const gvqlComputedReturn = await time(() =>
    storage.gvql("MATCH (doc:Document) RETURN doc.id AS id, (doc.views + $bonus) * 2 AS score ORDER BY score DESC LIMIT 25", {
      parameters: { bonus: 3 },
    }),
  );
  const gvqlScalarFunctions = await time(() =>
    storage.gvql('MATCH (doc:Document) WHERE lower(doc.title) CONTAINS lower($needle) RETURN upper(trim(doc.title)) AS title, length(doc.title) AS titleLength LIMIT 25', {
      parameters: { needle: "DOCUMENT" },
    }),
  );
  const gvqlCaseExpression = await time(() =>
    storage.gvql(
      'MATCH (doc:Document) RETURN doc.id AS id, CASE WHEN doc.status = "archived" THEN "cold" WHEN doc.views > 5000 THEN "hot" ELSE "normal" END AS bucket ORDER BY doc.id ASC LIMIT 25',
    ),
  );
  const gvqlWithPipeline = await time(() =>
    storage.gvql(
      'MATCH (doc:Document) WITH doc.status AS status, count(*) AS count, avg(doc.views) AS avgViews GROUP BY doc.status HAVING count > 0 RETURN status, count, avgViews ORDER BY count DESC',
    ),
  );
  const gvqlCreatePreview = await time(() =>
    storage.previewGvql(
      'MATCH (doc:Document) WHERE doc.id = 1 CREATE (created:Document { id: 1000001, title: "Benchmark create", status: "draft", views: $views }) INTO doc.related RETURN created.id AS id',
      { parameters: { views: 42 } },
    ),
  );
  const gvqlMergePreview = await time(() =>
    storage.previewGvql(
      'MATCH (doc:Document) WHERE doc.id = 1 MERGE (merged:Document { id: 1000002, title: "Benchmark merge", status: "draft", views: $views }) INTO doc.related ON merged.id RETURN merged.id AS id',
      { parameters: { views: 43 } },
    ),
  );
  const gvqlDeletePreview = await time(() =>
    storage.previewGvql('MATCH (doc:Document) WHERE doc.id = 1 DELETE doc RETURN doc.id AS id'),
  );
  await storage.shutdown();
  const load = await time(async () => {
    const loaded = await EmbeddedStorage.start({ storageDirectory: directory, storageTarget: target, rootFactory: () => ({}), types: typeRegistrations() });
    await loaded.shutdown();
  });
  return {
    target: "memory",
    count,
    storeMs: store.ms,
    gvqlMs: gvql.ms,
    gvqlMultiMatchMs: gvqlMultiMatch.ms,
    gvqlOptionalMatchMs: gvqlOptionalMatch.ms,
    gvqlIndexedMs: gvqlIndexed.ms,
    gvqlMultiIndexMs: gvqlMultiIndex.ms,
    gvqlIndexedInMs: gvqlIndexedIn.ms,
    gvqlIndexedOrMs: gvqlIndexedOr.ms,
    gvqlComputedReturnMs: gvqlComputedReturn.ms,
    gvqlScalarFunctionsMs: gvqlScalarFunctions.ms,
    gvqlCaseExpressionMs: gvqlCaseExpression.ms,
    gvqlWithPipelineMs: gvqlWithPipeline.ms,
    gvqlCreatePreviewMs: gvqlCreatePreview.ms,
    gvqlMergePreviewMs: gvqlMergePreview.ms,
    gvqlDeletePreviewMs: gvqlDeletePreview.ms,
    loadMs: load.ms,
    bytes: undefined,
  };
}

async function benchmarkFilesystem(count, options = {}) {
  const { target = "filesystem", storageOptions = {} } = options;
  const directory = await mkdtemp(join(tmpdir(), "graphvault-bench-"));
  try {
    const root = createRoot(count);
    const storage = await EmbeddedStorage.start({ storageDirectory: directory, root, types: typeRegistrations(), ...storageOptions });
    const store = await time(() => storage.storeRoot());
    const gvql = await time(() =>
      storage.gvql('MATCH (doc:Document)-[:owner]->(owner:Owner) WHERE owner.name = "Owner 1" RETURN doc.id AS id, doc.title AS title LIMIT 25'),
    );
    const gvqlMultiMatch = await time(() =>
      storage.gvql(
        'MATCH (doc:Document)-[:owner]->(owner:Owner), (doc)-[:category]->(category:Category) WHERE owner.name = "Owner 1" AND category.slug = "cat-1" RETURN doc.id AS id, category.label AS category LIMIT 25',
      ),
    );
    const gvqlOptionalMatch = await time(() =>
      storage.gvql(
        'MATCH (doc:Document) OPTIONAL MATCH (doc)-[:related]->(items)-[:*]->(related:Document) RETURN doc.id AS id, related.id AS relatedId ORDER BY doc.id ASC LIMIT 25',
      ),
    );
    const gvqlIndexed = await time(() =>
      storage.gvql(
        'MATCH (doc:Document) WHERE doc.status = "active" RETURN doc.status AS status, count(*) AS count, avg(doc.views) AS avgViews GROUP BY doc.status HAVING count > 0 ORDER BY count DESC',
      ),
    );
    const gvqlMultiIndex = await time(() =>
      storage.gvql('MATCH (doc:Document) WHERE doc.status = "active" AND doc.id = 1 RETURN doc.id AS id, doc.title AS title'),
    );
    const gvqlIndexedIn = await time(() =>
      storage.gvql('MATCH (doc:Document) WHERE doc.status IN ["active", "review"] AND doc.id IN [1, 7, 14, 21] RETURN doc.id AS id ORDER BY doc.id ASC'),
    );
    const gvqlIndexedOr = await time(() =>
      storage.gvql('MATCH (doc:Document) WHERE doc.id = 1 OR doc.status = "review" RETURN doc.id AS id ORDER BY doc.id ASC LIMIT 25'),
    );
    const gvqlComputedReturn = await time(() =>
      storage.gvql("MATCH (doc:Document) RETURN doc.id AS id, (doc.views + $bonus) * 2 AS score ORDER BY score DESC LIMIT 25", {
        parameters: { bonus: 3 },
      }),
    );
    const gvqlScalarFunctions = await time(() =>
      storage.gvql('MATCH (doc:Document) WHERE lower(doc.title) CONTAINS lower($needle) RETURN upper(trim(doc.title)) AS title, length(doc.title) AS titleLength LIMIT 25', {
        parameters: { needle: "DOCUMENT" },
      }),
    );
    const gvqlCaseExpression = await time(() =>
      storage.gvql(
        'MATCH (doc:Document) RETURN doc.id AS id, CASE WHEN doc.status = "archived" THEN "cold" WHEN doc.views > 5000 THEN "hot" ELSE "normal" END AS bucket ORDER BY doc.id ASC LIMIT 25',
      ),
    );
    const gvqlWithPipeline = await time(() =>
      storage.gvql(
        'MATCH (doc:Document) WITH doc.status AS status, count(*) AS count, avg(doc.views) AS avgViews GROUP BY doc.status HAVING count > 0 RETURN status, count, avgViews ORDER BY count DESC',
      ),
    );
    const gvqlCreatePreview = await time(() =>
      storage.previewGvql(
        'MATCH (doc:Document) WHERE doc.id = 1 CREATE (created:Document { id: 1000001, title: "Benchmark create", status: "draft", views: $views }) INTO doc.related RETURN created.id AS id',
        { parameters: { views: 42 } },
      ),
    );
    const gvqlMergePreview = await time(() =>
      storage.previewGvql(
        'MATCH (doc:Document) WHERE doc.id = 1 MERGE (merged:Document { id: 1000002, title: "Benchmark merge", status: "draft", views: $views }) INTO doc.related ON merged.id RETURN merged.id AS id',
        { parameters: { views: 43 } },
      ),
    );
    const gvqlDeletePreview = await time(() =>
      storage.previewGvql('MATCH (doc:Document) WHERE doc.id = 1 DELETE doc RETURN doc.id AS id'),
    );
    await storage.shutdown();
    const load = await time(async () => {
      const loaded = await EmbeddedStorage.start({ storageDirectory: directory, rootFactory: () => ({}), types: typeRegistrations(), ...storageOptions });
      await loaded.shutdown();
    });
    return {
      target,
      count,
      storeMs: store.ms,
      gvqlMs: gvql.ms,
      gvqlMultiMatchMs: gvqlMultiMatch.ms,
      gvqlOptionalMatchMs: gvqlOptionalMatch.ms,
      gvqlIndexedMs: gvqlIndexed.ms,
      gvqlMultiIndexMs: gvqlMultiIndex.ms,
      gvqlIndexedInMs: gvqlIndexedIn.ms,
      gvqlIndexedOrMs: gvqlIndexedOr.ms,
      gvqlComputedReturnMs: gvqlComputedReturn.ms,
      gvqlScalarFunctionsMs: gvqlScalarFunctions.ms,
      gvqlCaseExpressionMs: gvqlCaseExpression.ms,
      gvqlWithPipelineMs: gvqlWithPipeline.ms,
      gvqlCreatePreviewMs: gvqlCreatePreview.ms,
      gvqlMergePreviewMs: gvqlMergePreview.ms,
      gvqlDeletePreviewMs: gvqlDeletePreview.ms,
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

const options = parseArgs(process.argv.slice(2));
const rows = [];
for (const count of options.sizes) {
  if (options.targets.includes("memory")) {
    rows.push(await benchmarkMemory(count));
  }
  if (options.targets.includes("filesystem/production")) {
    rows.push(await benchmarkFilesystem(count, { target: "filesystem/production" }));
  }
  if (options.targets.includes("filesystem/inspect")) {
    rows.push(await benchmarkFilesystem(count, { target: "filesystem/inspect", storageOptions: { writeProfile: "inspect" } }));
  }
}

const result = {
  metadata: {
    runtime: process.version,
    platform: process.platform,
    arch: process.arch,
    date: new Date().toISOString(),
    sizes: options.sizes,
    targets: options.targets,
  },
  rows,
};

if (options.assertBudgets) {
  assertPerformanceBudgets(rows);
}

const output = options.json ? `${JSON.stringify(result, null, 2)}\n` : markdownReport(result);
if (options.output) {
  await writeFile(options.output, output);
} else {
  process.stdout.write(output);
}

function markdownReport(result) {
  const lines = [
    "# GraphVault object graph benchmark",
    "",
    `Runtime: ${result.metadata.runtime}`,
    `Platform: ${result.metadata.platform} ${result.metadata.arch}`,
    `Date: ${result.metadata.date}`,
    "",
    "| target | documents | storeRoot | GVQL traversal | GVQL multi-match join | GVQL optional match | GVQL indexed aggregate | GVQL multi-index lookup | GVQL indexed IN lookup | GVQL indexed OR lookup | GVQL computed return | GVQL scalar functions | GVQL CASE expression | GVQL WITH pipeline | GVQL CREATE preview | GVQL MERGE preview | GVQL DELETE preview | reload | storage size |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of result.rows) {
    lines.push(
      `| ${row.target} | ${row.count.toLocaleString("en-US")} | ${formatMs(row.storeMs)} | ${formatMs(row.gvqlMs)} | ${formatMs(row.gvqlMultiMatchMs)} | ${formatMs(row.gvqlOptionalMatchMs)} | ${formatMs(row.gvqlIndexedMs)} | ${formatMs(row.gvqlMultiIndexMs)} | ${formatMs(row.gvqlIndexedInMs)} | ${formatMs(row.gvqlIndexedOrMs)} | ${formatMs(row.gvqlComputedReturnMs)} | ${formatMs(row.gvqlScalarFunctionsMs)} | ${formatMs(row.gvqlCaseExpressionMs)} | ${formatMs(row.gvqlWithPipelineMs)} | ${formatMs(row.gvqlCreatePreviewMs)} | ${formatMs(row.gvqlMergePreviewMs)} | ${formatMs(row.gvqlDeletePreviewMs)} | ${formatMs(row.loadMs)} | ${formatBytes(row.bytes)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(args) {
  const options = {
    sizes: defaultSizes,
    targets: allTargets,
    json: false,
    output: undefined,
    assertBudgets: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--assert") {
      options.assertBudgets = true;
      continue;
    }
    if (arg === "--output") {
      options.output = readArgValue(args, ++index, arg);
      continue;
    }
    if (arg === "--sizes") {
      options.sizes = readArgValue(args, ++index, arg).split(",").map((value) => Number.parseInt(value.trim(), 10)).filter(Number.isFinite);
      continue;
    }
    if (arg === "--targets") {
      options.targets = readArgValue(args, ++index, arg).split(",").map((value) => value.trim()).filter(Boolean);
      continue;
    }
    throw new Error(`Unknown benchmark option: ${arg}`);
  }
  if (options.sizes.length === 0) {
    throw new Error("At least one benchmark size is required.");
  }
  for (const target of options.targets) {
    if (!allTargets.includes(target)) {
      throw new Error(`Unknown benchmark target: ${target}`);
    }
  }
  return options;
}

function readArgValue(args, index, option) {
  const value = args[index];
  if (!value) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function assertPerformanceBudgets(rows) {
  const failures = [];
  for (const row of rows) {
    const budget = performanceBudgets[row.target];
    for (const [metric, maximum] of Object.entries(budget ?? {})) {
      if (row[metric] > maximum) {
        failures.push(`${row.target}/${row.count} ${metric} ${row[metric].toFixed(1)} ms > ${maximum} ms`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`Performance budget exceeded:\n${failures.join("\n")}`);
  }
}
