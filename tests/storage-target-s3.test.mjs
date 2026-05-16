import assert from "node:assert/strict";
import { S3StorageTarget } from "../dist/storage/targets/s3.js";

class MockS3Client {
  constructor() {
    this.store = new Map();
    this.putErrorsLeft = 0;
    this.deleted = [];
  }

  async headObject({ bucket, key }) {
    if (!this.store.get(`${bucket}/${key}`)) {
      throw new Error("not found");
    }
  }

  async getObject({ bucket, key }) {
    const value = this.store.get(`${bucket}/${key}`);
    if (!value) {
      throw new Error("missing");
    }
    return { body: value.body };
  }

  async putObject({ bucket, key, body, ifNoneMatch }) {
    const full = `${bucket}/${key}`;
    if (ifNoneMatch === "*" && this.store.has(full)) {
      throw new Error("exists");
    }
    if (this.putErrorsLeft > 0) {
      this.putErrorsLeft -= 1;
      throw new Error("conflict");
    }
    this.store.set(full, { body, bucket, key });
    return {};
  }

  async deleteObject({ bucket, key }) {
    this.deleted.push(`${bucket}/${key}`);
    this.store.delete(`${bucket}/${key}`);
    return {};
  }

  async listObjects({ bucket, prefix, continuationToken }) {
    const continuation = continuationToken ? Number(continuationToken) : 0;
    const all = Array.from(this.store.keys())
      .filter((name) => name.startsWith(`${bucket}/${prefix}`))
      .map((name) => name.slice(`${bucket}/`.length));
    const chunks = [all.slice(0, 2), all.slice(2)];
    if (continuation >= chunks.length) {
      return { objects: [] };
    }
    const next = continuation + 1 < chunks.length ? String(continuation + 1) : undefined;
    const commonPrefixes = chunks[continuation]
      .map((item) => `${item}/`)
      .filter((name) => name.endsWith("/"));
    return {
      objects: chunks[continuation].map((key) => ({ key })),
      ...(commonPrefixes.length ? { commonPrefixes } : {}),
      ...(next ? { nextContinuationToken: next } : {}),
    };
  }
}

const client = new MockS3Client();
const target = new S3StorageTarget({ client, bucket: "gv-bucket", prefix: "unit" });

await target.ensureDirectory("root");
assert.equal(await target.exists("root"), true);

await target.writeTextAtomic("root/notes.txt", "alpha");
await target.appendText("root/notes.txt", "-beta");
assert.equal(await target.readText("root/notes.txt"), "alpha-beta");

assert.equal(await target.exists("root/missing"), false);
assert.equal(await target.exists("root/notes.txt"), true);

const list = await target.list("root");
assert.equal(list.includes("notes.txt"), true);

await target.remove("root/notes.txt");
await assert.rejects(() => target.readBuffer("root/notes.txt"), /missing|No body returned for S3 object/);

const flakyClient = new MockS3Client();
flakyClient.putErrorsLeft = 1;
const lockTarget = new S3StorageTarget({ client: flakyClient, bucket: "gv-lock", prefix: "locks" });
await assert.rejects(() => lockTarget.acquireLock("locks/test", 0), /Storage is already locked at s3/);

const retryClient = new MockS3Client();
retryClient.putErrorsLeft = 1;
const retryTarget = new S3StorageTarget({ client: retryClient, bucket: "gv-lock", prefix: "locks" });
const handle = await retryTarget.acquireLock("locks/retry", 500);
await handle.release();

const timeoutClient = new MockS3Client();
timeoutClient.putErrorsLeft = Number.POSITIVE_INFINITY;
const timeoutTarget = new S3StorageTarget({ client: timeoutClient, bucket: "gv-lock", prefix: "locks" });
await assert.rejects(() => timeoutTarget.acquireLock("locks/timeout", 0), /Storage is already locked at s3/);

const recursiveClient = new MockS3Client();
await recursiveClient.putObject({
  bucket: "gv-recursive",
  key: "root/a/file.txt",
  body: Buffer.from("a"),
});
await recursiveClient.putObject({
  bucket: "gv-recursive",
  key: "root/a/b/file.txt",
  body: Buffer.from("b"),
});
const recursiveTarget = new S3StorageTarget({ client: recursiveClient, bucket: "gv-recursive", prefix: "root" });
await recursiveTarget.remove("a", { recursive: true });
assert.ok(recursiveClient.deleted.length > 0);

const invalidBodyClient = new MockS3Client();
invalidBodyClient.store.set("gv-invalid/bad", { body: { stream: "not-a-buffer" } });
const invalidTarget = new S3StorageTarget({ client: invalidBodyClient, bucket: "gv-invalid" });
await assert.rejects(() => invalidTarget.readBuffer("bad"));

const bodyClient = new MockS3Client();
const bodyTarget = new S3StorageTarget({ client: bodyClient, bucket: "gv-body" });
bodyClient.store.set("gv-body/string", { body: "text-body" });
assert.equal((await bodyTarget.readBuffer("string")).toString("utf8"), "text-body");
bodyClient.store.set("gv-body/array-buffer", { body: new TextEncoder().encode("array-buffer").buffer });
assert.equal((await bodyTarget.readBuffer("array-buffer")).toString("utf8"), "array-buffer");
bodyClient.store.set("gv-body/uint8", { body: new TextEncoder().encode("uint8") });
assert.equal((await bodyTarget.readBuffer("uint8")).toString("utf8"), "uint8");
bodyClient.store.set("gv-body/transform", { body: { transformToByteArray: async () => new TextEncoder().encode("transform") } });
assert.equal((await bodyTarget.readBuffer("transform")).toString("utf8"), "transform");
bodyClient.store.set("gv-body/stream", { body: streamChunks(["stream-", "body"]) });
assert.equal((await bodyTarget.readBuffer("stream")).toString("utf8"), "stream-body");
bodyClient.store.set("gv-body/empty", {});
await assert.rejects(() => bodyTarget.readBuffer("empty"), /No body returned/);

const staleClient = new MockS3Client();
staleClient.store.set("gv-stale/locks/test", {
  body: Buffer.from(JSON.stringify({ createdAt: new Date(Date.now() - 10_000).toISOString(), fencingToken: 1 })),
});
staleClient.store.set("gv-stale/locks/test.fencing-token", { body: Buffer.from("41") });
const staleTarget = new S3StorageTarget({ client: staleClient, bucket: "gv-stale" });
const staleHandle = await staleTarget.acquireLock("locks/test", 0, { staleLockTimeoutMs: 1 });
assert.equal(staleHandle.fencingToken, 42);
await staleHandle.assertValid();
await staleHandle.release();

const invalidTokenClient = new MockS3Client();
const invalidTokenTarget = new S3StorageTarget({ client: invalidTokenClient, bucket: "gv-invalid-token" });
const invalidTokenHandle = await invalidTokenTarget.acquireLock("lock", 0);
invalidTokenClient.store.set("gv-invalid-token/lock", { body: Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), fencingToken: 999 })) });
await assert.rejects(() => invalidTokenHandle.assertValid(), /no longer valid/);
await assert.doesNotReject(() => invalidTokenHandle.release());

const nonStaleClient = new MockS3Client();
nonStaleClient.store.set("gv-non-stale/lock", { body: Buffer.from("{not json") });
const nonStaleTarget = new S3StorageTarget({ client: nonStaleClient, bucket: "gv-non-stale" });
await assert.rejects(() => nonStaleTarget.acquireLock("lock", 0, { staleLockTimeoutMs: 1 }), /already locked/);

async function* streamChunks(chunks) {
  for (const chunk of chunks) {
    yield new TextEncoder().encode(chunk);
  }
}
