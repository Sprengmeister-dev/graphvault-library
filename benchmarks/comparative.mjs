import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { EmbeddedStorage } from "../dist/index.js";

const defaultCount = 500;

class CaseRecord {
  constructor(id) {
    this.id = `case-${id}`;
    this.status = id % 7 === 0 ? "escalated" : id % 3 === 0 ? "review" : "open";
    this.risk = id % 11 === 0 ? "high" : id % 5 === 0 ? "medium" : "low";
    this.owner = { id: `user-${id % 24}`, name: `Investigator ${id % 24}` };
    this.payments = Array.from({ length: 3 }, (_, index) => ({
      id: `payment-${id}-${index}`,
      amount: id * 100 + index * 17,
      currency: "EUR",
    }));
    this.links = id > 0 ? [{ type: "related", targetId: `case-${id - 1}` }] : [];
  }
}

function createRoot(count) {
  return {
    generatedAt: new Date("2026-05-16T12:00:00.000Z"),
    cases: Array.from({ length: count }, (_, index) => new CaseRecord(index)),
  };
}

function typeRegistrations() {
  return [{ name: "CaseRecord", ctor: CaseRecord }];
}

async function benchmarkGraphVault(count) {
  const directory = await mkdtemp(join(tmpdir(), "graphvault-compare-"));
  try {
    const storage = await EmbeddedStorage.start({
      storageDirectory: directory,
      root: createRoot(count),
      types: typeRegistrations(),
      writeProfile: "production",
      indexes: {
        mode: "configured",
        properties: [
          { type: "CaseRecord", path: "status" },
          { type: "CaseRecord", path: "risk" },
        ],
      },
    });
    const store = await time(() => storage.storeRoot());
    const query = await time(() =>
      storage.gvql(
        'MATCH (item:CaseRecord) WHERE item.status = "open" AND item.risk = "high" RETURN item.id AS id, item.owner.name AS owner LIMIT 25',
      ),
    );
    await storage.shutdown();
    const load = await time(async () => {
      const loaded = await EmbeddedStorage.start({
        storageDirectory: directory,
        rootFactory: () => ({ cases: [] }),
        types: typeRegistrations(),
        writeProfile: "production",
      });
      await loaded.shutdown();
    });
    return { target: "graphvault/production", count, storeMs: store.ms, queryMs: query.ms, loadMs: load.ms, bytes: await directorySize(directory) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function benchmarkJsonProjection(count) {
  const directory = await mkdtemp(join(tmpdir(), "graphvault-json-compare-"));
  const path = join(directory, "cases.json");
  try {
    const projection = createRoot(count).cases.map((item) => ({
      id: item.id,
      status: item.status,
      risk: item.risk,
      ownerName: item.owner.name,
      payments: item.payments,
      links: item.links,
    }));
    const store = await time(() => writeFile(path, JSON.stringify(projection)));
    const query = await time(async () => {
      projection.filter((item) => item.status === "open" && item.risk === "high").slice(0, 25);
    });
    const load = await time(async () => {
      JSON.parse(await readFile(path, "utf8"));
    });
    return { target: "json-file/projection", count, storeMs: store.ms, queryMs: query.ms, loadMs: load.ms, bytes: await fileSize(path) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function benchmarkSqliteRows(count) {
  const { default: initSqlJs } = await import("sql.js");
  const benchmarkDirectory = dirname(fileURLToPath(import.meta.url));
  const SQL = await initSqlJs({
    locateFile: (file) => join(benchmarkDirectory, "..", "node_modules", "sql.js", "dist", file),
  });
  const database = new SQL.Database();
  try {
    const root = createRoot(count);
    const store = await time(() => {
      database.run("CREATE TABLE cases (id TEXT PRIMARY KEY, status TEXT NOT NULL, risk TEXT NOT NULL, owner_name TEXT NOT NULL)");
      database.run("CREATE TABLE payments (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL)");
      database.run("CREATE INDEX idx_cases_status_risk ON cases(status, risk)");
      database.run("BEGIN IMMEDIATE");
      const insertCase = database.prepare("INSERT INTO cases VALUES (?, ?, ?, ?)");
      const insertPayment = database.prepare("INSERT INTO payments VALUES (?, ?, ?, ?)");
      try {
        for (const item of root.cases) {
          insertCase.run([item.id, item.status, item.risk, item.owner.name]);
          for (const payment of item.payments) {
            insertPayment.run([payment.id, item.id, payment.amount, payment.currency]);
          }
        }
      } finally {
        insertCase.free();
        insertPayment.free();
      }
      database.run("COMMIT");
    });
    const query = await time(() => {
      const rows = [];
      const statement = database.prepare(
        'SELECT id, owner_name AS owner FROM cases WHERE status = "open" AND risk = "high" LIMIT 25',
      );
      try {
        while (statement.step()) rows.push(statement.getAsObject());
      } finally {
        statement.free();
      }
    });
    const bytes = database.export();
    const load = await time(() => {
      const loaded = new SQL.Database(bytes);
      loaded.close();
    });
    return { target: "sqlite/normalized", count, storeMs: store.ms, queryMs: query.ms, loadMs: load.ms, bytes: bytes.length };
  } finally {
    database.close();
  }
}

async function time(work) {
  const started = performance.now();
  await work();
  return { ms: performance.now() - started };
}

async function directorySize(path) {
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;
  const children = await import("node:fs/promises").then((fs) => fs.readdir(path));
  let total = 0;
  for (const child of children) total += await directorySize(join(path, child));
  return total;
}

async function fileSize(path) {
  return (await stat(path)).size;
}

function formatMs(value) {
  return `${value.toFixed(1)} ms`;
}

function formatBytes(value) {
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}

function parseArgs(args) {
  const options = { count: defaultCount, json: false, output: undefined };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--count") options.count = Number.parseInt(args[++index], 10);
    else if (arg === "--output") options.output = args[++index];
    else throw new Error(`Unknown benchmark option: ${arg}`);
  }
  if (!Number.isFinite(options.count) || options.count < 1) throw new Error("--count must be a positive integer.");
  return options;
}

function markdownReport(result) {
  const lines = [
    "# GraphVault comparative benchmark",
    "",
    `Runtime: ${result.metadata.runtime}`,
    `Platform: ${result.metadata.platform} ${result.metadata.arch}`,
    `Date: ${result.metadata.date}`,
    "",
    "| target | cases | store | indexed query | reload/open | storage size |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of result.rows) {
    lines.push(
      `| ${row.target} | ${row.count.toLocaleString("en-US")} | ${formatMs(row.storeMs)} | ${formatMs(row.queryMs)} | ${formatMs(row.loadMs)} | ${formatBytes(row.bytes)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const options = parseArgs(process.argv.slice(2));
const rows = [
  await benchmarkGraphVault(options.count),
  await benchmarkJsonProjection(options.count),
  await benchmarkSqliteRows(options.count),
];
const result = {
  metadata: {
    runtime: process.version,
    platform: process.platform,
    arch: process.arch,
    date: new Date().toISOString(),
    count: options.count,
  },
  rows,
};

const output = options.json ? `${JSON.stringify(result, null, 2)}\n` : markdownReport(result);
if (options.output) await writeFile(options.output, output);
else process.stdout.write(output);
