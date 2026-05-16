import assert from "node:assert/strict";
import pg from "pg";
import { EmbeddedStorage, StorageLockError } from "../dist/index.js";
import { SqlStorageTarget } from "../dist/storage/targets/sql.js";

const databaseUrl = process.env.GRAPHVAULT_POSTGRES_URL;

async function assertSqlStorageTargetOnRealPostgres(pool) {
  const targetA = createPostgresTarget(pool);
  const targetB = createPostgresTarget(pool);

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
}

async function assertPostgresTransactionRollback(pool) {
  const client = new PgStorageClient(pool);
  const target = createPostgresTarget(pool, client);

  await target.writeTextAtomic("/rollback/value.txt", "original");
  client.failNextInsert = true;
  await assert.rejects(() => target.writeTextAtomic("/rollback/value.txt", "replacement"), /injected insert failure/);
  assert.equal(await target.readText("/rollback/value.txt"), "original");
}

async function assertEmbeddedStorageRoundTripOnPostgres(pool) {
  const storageDirectory = "postgres-integration-store";
  const storage = await EmbeddedStorage.start({
    storageDirectory,
    storageTarget: createPostgresTarget(pool),
    rootFactory: () => ({ tickets: [] }),
    lockStrategy: "pessimistic",
    staleLockTimeoutMs: 1_000,
  });

  storage.root.tickets.push({
    id: "ticket-1",
    title: "Payment approval blocked by missing evidence",
    status: "triage",
    links: [{ type: "depends-on", targetId: "payment-42" }],
  });
  await storage.storeRoot();
  await storage.gvql('MATCH (ticket) WHERE ticket.id = "ticket-1" SET ticket.status = "investigating"');
  await storage.shutdown();

  const restored = await EmbeddedStorage.start({
    storageDirectory,
    storageTarget: createPostgresTarget(pool),
    rootFactory: () => ({ tickets: [] }),
    readOnly: true,
  });

  const result = await restored.gvql(
    'MATCH (ticket) WHERE ticket.id = "ticket-1" RETURN ticket.title AS title, ticket.status AS status',
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].title, "Payment approval blocked by missing evidence");
  assert.equal(result.rows[0].status, "investigating");
  assert.equal(restored.root.tickets[0].links[0].targetId, "payment-42");
  await restored.shutdown();
}

function createPostgresTarget(pool, client) {
  return new SqlStorageTarget({
    client: client ?? new PgStorageClient(pool),
    dialect: "postgres",
    tableName: "gv_pg_objects",
    lockTableName: "gv_pg_locks",
  });
}

async function resetTables(pool) {
  await pool.query('DROP TABLE IF EXISTS "gv_pg_objects"');
  await pool.query('DROP TABLE IF EXISTS "gv_pg_locks"');
}

async function withPostgres(connectionString, work) {
  const pool = new pg.Pool({ connectionString, max: 4 });
  try {
    await work(pool);
  } finally {
    await pool.end();
  }
}

class PgStorageClient {
  constructor(pool) {
    this.pool = pool;
    this.transactionClient = undefined;
    this.failNextInsert = false;
  }

  async execute(sql, parameters = []) {
    if (this.failNextInsert && /^\s*INSERT\b/i.test(sql)) {
      this.failNextInsert = false;
      throw new Error("injected insert failure");
    }

    const client = this.transactionClient ?? this.pool;
    const result = await client.query(sql, parameters);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  async transaction(work) {
    if (this.transactionClient) {
      return work();
    }

    const client = await this.pool.connect();
    this.transactionClient = client;
    try {
      await client.query("BEGIN");
      const result = await work();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      this.transactionClient = undefined;
      client.release();
    }
  }
}

if (!databaseUrl) {
  console.log("Skipping Postgres integration test: GRAPHVAULT_POSTGRES_URL is not set.");
} else {
  await withPostgres(databaseUrl, async (pool) => {
    await resetTables(pool);
    await assertSqlStorageTargetOnRealPostgres(pool);
    await resetTables(pool);
    await assertPostgresTransactionRollback(pool);
    await resetTables(pool);
    await assertEmbeddedStorageRoundTripOnPostgres(pool);
  });
}
