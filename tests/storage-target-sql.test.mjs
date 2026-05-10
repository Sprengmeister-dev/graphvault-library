import assert from "node:assert/strict";
import { SqlStorageTarget } from "../dist/storage/targets/sql.js";

class MockSqlClient {
  constructor() {
    this.bodyByPath = new Map();
    this.lockTableName = "";
    this.lockFailures = 0;
    this.objectWrites = 0;
    this.defaultRows = { rows: [], rowCount: 0 };
  }

  async execute(sql, parameters = []) {
    if (sql.includes("CREATE TABLE")) {
      return this.defaultRows;
    }

    if (sql.includes("INSERT INTO")) {
      this.objectWrites += 1;
      if (this.lockTableName && sql.includes(this.lockTableName)) {
        if (this.lockFailures > 0) {
          this.lockFailures -= 1;
          throw new Error("duplicate lock");
        }
        return this.defaultRows;
      }
      const key = parameters[0];
      const body = parameters[1];
      this.bodyByPath.set(key, body);
      return this.defaultRows;
    }

    if (sql.includes("DELETE FROM")) {
      const key = parameters[0];
      if (sql.includes("LIKE")) {
        const prefix = key.replace("%", "");
        for (const path of Array.from(this.bodyByPath.keys())) {
          if (path.startsWith(prefix)) {
            this.bodyByPath.delete(path);
          }
        }
      } else {
        this.bodyByPath.delete(key);
      }
      return this.defaultRows;
    }
    
    if (sql.includes("SELECT body")) {
      const key = parameters[0];
      const body = this.bodyByPath.get(key);
      if (body === undefined) {
        return { rows: [] };
      }
      return { rows: [{ body }] };
    }

    if (sql.includes("SELECT path FROM") && sql.includes("LIMIT 1")) {
      const key = parameters[0];
      return { rows: this.bodyByPath.has(key) ? [{ path: key }] : [] };
    }

    if (sql.includes("SELECT path FROM") && sql.includes("LIKE")) {
      const prefix = parameters[0].replace("%", "");
      const rows = Array.from(this.bodyByPath.keys())
        .filter((path) => path.startsWith(prefix))
        .map((path) => ({ path }));
      return { rows };
    }

    if (sql.includes("DELETE FROM") && sql.includes("LIKE")) {
      const prefix = parameters[0].replace("%", "");
      for (const path of Array.from(this.bodyByPath.keys())) {
        if (path.startsWith(prefix)) {
          this.bodyByPath.delete(path);
        }
      }
      return this.defaultRows;
    }

    return this.defaultRows;
  }
}

const objectClient = new MockSqlClient();
const target = new SqlStorageTarget({
  client: objectClient,
  tableName: "gv_test_objects",
  lockTableName: "gv_test_locks",
});
objectClient.lockTableName = "gv_test_locks";

await target.ensureDirectory("/tmp/root");
await target.writeBufferAtomic("/tmp/root/hello.txt", Buffer.from("hello"));
await target.appendText("/tmp/root/hello.txt", "!");
assert.equal(await target.readText("/tmp/root/hello.txt"), "hello!");
assert.equal(await target.exists("/tmp/root/hello.txt"), true);

const list = await target.list("/tmp/root");
assert.deepEqual(list, ["hello.txt"]);

await target.remove("/tmp/root/hello.txt", { recursive: true });
await assert.rejects(() => target.readBuffer("/tmp/root/hello.txt"), /No such SQL storage object/);
await target.writeTextAtomic("/tmp/root/hello.txt", "x");
assert.equal(await target.readText("/tmp/root/hello.txt"), "x");

const lockClient = new MockSqlClient();
lockClient.lockTableName = "gv_test_locks";
lockClient.lockFailures = 1;
const lockTarget = new SqlStorageTarget({
  client: lockClient,
  tableName: "gv_test_objects",
  lockTableName: "gv_test_locks",
});
const lockHandle = await lockTarget.acquireLock("/tmp/lock.lock", 20);
await lockHandle.release();

const timeoutClient = new MockSqlClient();
timeoutClient.lockTableName = "gv_test_locks";
timeoutClient.lockFailures = Number.POSITIVE_INFINITY;
const timeoutTarget = new SqlStorageTarget({
  client: timeoutClient,
  tableName: "gv_test_objects",
  lockTableName: "gv_test_locks",
});
await assert.rejects(() => timeoutTarget.acquireLock("/tmp/timeout.lock", 0), /Storage is already locked in SQL target/);

const invalidBodyClient = new MockSqlClient();
invalidBodyClient.lockTableName = "gv_test_locks";
invalidBodyClient.bodyByPath.set("/tmp/bad.bin", 123);
const invalidBodyTarget = new SqlStorageTarget({
  client: invalidBodyClient,
  tableName: "gv_test_objects",
  lockTableName: "gv_test_locks",
});
await assert.rejects(() => invalidBodyTarget.readBuffer("/tmp/bad.bin"), /Unsupported SQL body value/);
