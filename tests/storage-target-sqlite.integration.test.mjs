import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import { EmbeddedStorage, StorageLockError } from "../dist/index.js";
import { SqlStorageTarget } from "../dist/storage/targets/sql.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const SQL = await initSqlJs({
  locateFile: (file) => join(testDirectory, "..", "node_modules", "sql.js", "dist", file),
});

async function assertSqlStorageTargetOnRealSqlite() {
  const database = new SQL.Database();
  const targetA = createSqliteTarget(database);
  const targetB = createSqliteTarget(database);

  try {
    await targetA.ensureDirectory("/case");
    await targetA.writeTextAtomic("/case/notes.txt", "alpha");
    await targetA.appendText("/case/notes.txt", "-beta");
    await targetA.writeBufferAtomic("/case/evidence/photo.bin", Buffer.from([1, 2, 3]));

    assert.equal(await targetA.readText("/case/notes.txt"), "alpha-beta");
    assert.deepEqual([...await targetA.readBuffer("/case/evidence/photo.bin")], [1, 2, 3]);
    assert.equal(await targetA.exists("/case"), true);
    assert.equal(await targetA.exists("/case/notes.txt"), true);
    assert.deepEqual(await targetA.list("/case"), ["evidence", "notes.txt"]);

    await targetA.remove("/case/evidence", { recursive: true });
    assert.equal(await targetA.exists("/case/evidence/photo.bin"), false);

    const first = await targetA.acquireLock("/case/LOCK", 50);
    assert.equal(first.fencingToken, 1);
    await first.assertValid();
    await assert.rejects(() => targetB.acquireLock("/case/LOCK", 0), StorageLockError);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await targetB.acquireLock("/case/LOCK", 100, { staleLockTimeoutMs: 1 });
    assert.equal(second.fencingToken, 2);
    await assert.rejects(() => first.assertValid(), StorageLockError);
    await first.release();
    await second.assertValid();
    await second.release();

    const third = await targetA.acquireLock("/case/LOCK", 50);
    assert.equal(third.fencingToken, 3);
    await third.release();
  } finally {
    database.close();
  }
}

async function assertSqliteTransactionRollback() {
  const database = new SQL.Database();
  const client = new SqlJsStorageClient(database);
  const target = createSqliteTarget(database, client);

  try {
    await target.writeTextAtomic("/rollback/value.txt", "original");
    client.failNextInsert = true;
    await assert.rejects(() => target.writeTextAtomic("/rollback/value.txt", "replacement"), /injected insert failure/);
    assert.equal(await target.readText("/rollback/value.txt"), "original");
  } finally {
    database.close();
  }
}

async function assertEmbeddedStorageRoundTripOnSqlite() {
  const database = new SQL.Database();
  const firstTarget = createSqliteTarget(database);
  const storageDirectory = "sqlite-integration-store";

  const storage = await EmbeddedStorage.start({
    storageDirectory,
    storageTarget: firstTarget,
    rootFactory: () => ({ tickets: [] }),
    lockStrategy: "pessimistic",
    staleLockTimeoutMs: 1_000,
  });

  storage.root.tickets.push({
    id: "ticket-1",
    title: "Invoice approval blocked by missing evidence",
    status: "triage",
    links: [{ type: "depends-on", targetId: "invoice-42" }],
  });
  await storage.storeRoot();
  await storage.gvql('MATCH (ticket) WHERE ticket.id = "ticket-1" SET ticket.status = "investigating"');
  await storage.shutdown();

  const persistedBytes = database.export();
  database.close();

  const restoredDatabase = new SQL.Database(persistedBytes);
  const restoredTarget = createSqliteTarget(restoredDatabase);
  try {
    const restored = await EmbeddedStorage.start({
      storageDirectory,
      storageTarget: restoredTarget,
      rootFactory: () => ({ tickets: [] }),
      readOnly: true,
    });

    const result = await restored.gvql(
      'MATCH (ticket) WHERE ticket.id = "ticket-1" RETURN ticket.title AS title, ticket.status AS status',
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].title, "Invoice approval blocked by missing evidence");
    assert.equal(result.rows[0].status, "investigating");
    assert.equal(restored.root.tickets[0].links[0].targetId, "invoice-42");
    await restored.shutdown();
  } finally {
    restoredDatabase.close();
  }
}

function createSqliteTarget(database, client) {
  return new SqlStorageTarget({
    client: client ?? new SqlJsStorageClient(database),
    tableName: "gv_sqlite_objects",
    lockTableName: "gv_sqlite_locks",
  });
}

class SqlJsStorageClient {
  constructor(database) {
    this.database = database;
    this.transactionDepth = 0;
    this.failNextInsert = false;
  }

  async execute(sql, parameters = []) {
    if (this.failNextInsert && /^\s*INSERT\b/i.test(sql)) {
      this.failNextInsert = false;
      throw new Error("injected insert failure");
    }

    const sqliteParameters = parameters.map(toSqliteParameter);
    if (/^\s*SELECT\b/i.test(sql)) {
      return this.select(sql, sqliteParameters);
    }

    this.database.run(sql, sqliteParameters);
    return { rows: [], rowCount: this.database.getRowsModified() };
  }

  async transaction(work) {
    if (this.transactionDepth > 0) {
      return work();
    }

    this.database.run("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = await work();
      this.transactionDepth -= 1;
      this.database.run("COMMIT");
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      this.database.run("ROLLBACK");
      throw error;
    }
  }

  select(sql, parameters) {
    const statement = this.database.prepare(sql);
    try {
      statement.bind(parameters);
      const rows = [];
      while (statement.step()) {
        rows.push(statement.getAsObject());
      }
      return { rows, rowCount: rows.length };
    } finally {
      statement.free();
    }
  }
}

function toSqliteParameter(value) {
  if (Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  return value;
}

await assertSqlStorageTargetOnRealSqlite();
await assertSqliteTransactionRollback();
await assertEmbeddedStorageRoundTripOnSqlite();
