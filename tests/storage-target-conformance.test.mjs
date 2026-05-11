import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HttpStorageTarget,
  EncryptedStorageTarget,
  LocalFilesystemTarget,
  MemoryStorageTarget,
  StorageLockError,
} from "../dist/index.js";
import { copyStorageTargetTree } from "../dist/storage/storage-target.js";

const localRoot = await mkdtemp(join(tmpdir(), "graphvault-target-contract-"));

try {
  await assertStorageTargetContract("memory", () => new MemoryStorageTarget(), "contract/memory");
  await assertStorageTargetContract(
    "encrypted-memory",
    () => new EncryptedStorageTarget({ target: new MemoryStorageTarget(), key: "contract-key" }),
    "contract/encrypted-memory",
  );
  await assertStorageTargetContract("local", () => new LocalFilesystemTarget(), localRoot);
  await assertStorageTargetContract("http", () => new HttpStorageTarget({ baseUrl: "https://graphvault.test", fetch: createMemoryFetch() }), "contract/http");
  await assertEncryptedStorageTarget();
} finally {
  await rm(localRoot, { recursive: true, force: true });
}

async function assertEncryptedStorageTarget() {
  const raw = new MemoryStorageTarget();
  const encrypted = new EncryptedStorageTarget({ target: raw, key: "correct-key" });
  await encrypted.writeTextAtomic("secure/value.txt", "sensitive ledger value");
  assert.equal(await encrypted.readText("secure/value.txt"), "sensitive ledger value");
  assert.equal((await raw.readText("secure/value.txt")).includes("sensitive ledger value"), false, "encrypted raw payload");
  await encrypted.appendText("secure/value.txt", "!");
  assert.equal(await encrypted.readText("secure/value.txt"), "sensitive ledger value!");
  const wrongKey = new EncryptedStorageTarget({ target: raw, key: "wrong-key" });
  await assert.rejects(() => wrongKey.readText("secure/value.txt"), undefined, "wrong key rejects");
}

async function assertStorageTargetContract(name, factory, root) {
  const target = factory();
  await assertBasicFileContract(target, `${root}/files`, name);
  await assertCopyTreeContract(factory(), factory(), `${root}/copy-source`, `${root}/copy-dest`, name);
  await assertLockContract(factory(), `${root}/LOCK`, name);
}

async function assertBasicFileContract(target, root, name) {
  await target.ensureDirectory(root);
  await target.writeTextAtomic(`${root}/a.txt`, "alpha");
  await target.appendText(`${root}/a.txt`, "-beta");
  assert.equal(await target.readText(`${root}/a.txt`), "alpha-beta", `${name}: append/read text`);
  await target.writeBufferAtomic(`${root}/nested/b.bin`, Buffer.from([1, 2, 3]));
  assert.deepEqual([...await target.readBuffer(`${root}/nested/b.bin`)], [1, 2, 3], `${name}: read buffer`);
  assert.equal(await target.exists(`${root}/a.txt`), true, `${name}: exists file`);
  assert.equal((await target.list(root)).includes("a.txt"), true, `${name}: list file`);
  assert.equal((await target.list(root)).includes("nested"), true, `${name}: list nested directory`);
  await target.remove(`${root}/nested`, { recursive: true });
  assert.equal(await target.exists(`${root}/nested/b.bin`), false, `${name}: recursive remove`);
  await target.remove(`${root}/a.txt`);
  await assert.rejects(() => target.readText(`${root}/a.txt`), undefined, `${name}: removed read rejects`);
}

async function assertCopyTreeContract(source, destination, sourceRoot, destinationRoot, name) {
  await source.writeTextAtomic(`${sourceRoot}/keep/a.txt`, "a");
  await source.writeTextAtomic(`${sourceRoot}/keep/b.txt`, "b");
  await source.writeTextAtomic(`${sourceRoot}/skip/secret.txt`, "secret");
  await source.writeTextAtomic(`${sourceRoot}/LOCK`, "volatile");
  const copied = await copyStorageTargetTree(source, destination, sourceRoot, destinationRoot, {
    exclude: (relativePath) => relativePath === "LOCK" || relativePath.startsWith("skip/"),
  });
  assert.equal(copied, 2, `${name}: copied expected file count`);
  assert.equal(await destination.readText(`${destinationRoot}/keep/a.txt`), "a", `${name}: copied nested file`);
  await assert.rejects(() => destination.readText(`${destinationRoot}/skip/secret.txt`), undefined, `${name}: excluded subtree`);
  await assert.rejects(() => destination.readText(`${destinationRoot}/LOCK`), undefined, `${name}: excluded lock file`);
}

async function assertLockContract(target, lockPath, name) {
  const first = await target.acquireLock(lockPath, 50);
  assert.equal(first.fencingToken, 1, `${name}: first fencing token`);
  await first.assertValid();
  await assert.rejects(() => target.acquireLock(lockPath, 0), StorageLockError, `${name}: lock conflict rejects`);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await target.acquireLock(lockPath, 100, { staleLockTimeoutMs: 1 });
  assert.equal(second.fencingToken, 2, `${name}: stale lock increments fencing token`);
  await assert.rejects(() => first.assertValid(), StorageLockError, `${name}: stale token invalid`);
  await first.release();
  await second.assertValid();
  await second.release();
  const third = await target.acquireLock(lockPath, 50);
  assert.equal(third.fencingToken, 3, `${name}: release keeps fencing monotonic`);
  await third.release();
}

function createMemoryFetch() {
  const files = new Map();
  const directories = new Set();
  return async (urlInput, init = {}) => {
    const url = new URL(String(urlInput));
    const path = decodeURIComponent(url.pathname.slice(1));
    const method = init.method ?? "GET";
    if (method === "HEAD") {
      return new Response(null, { status: files.has(path) || directories.has(path) ? 204 : 404 });
    }
    if (method === "GET" && url.searchParams.get("list") === "1") {
      return Response.json(listMemoryNames(files, directories, path));
    }
    if (method === "GET") {
      if (!files.has(path)) {
        return new Response("missing", { status: 404 });
      }
      return new Response(files.get(path));
    }
    if (method === "PUT" && url.searchParams.get("directory") === "1") {
      directories.add(path);
      return new Response(null, { status: 204 });
    }
    if (method === "PUT" && url.searchParams.get("lock") === "1") {
      if (files.has(path)) {
        return new Response("locked", { status: 409 });
      }
      files.set(path, Buffer.from(await bodyArrayBuffer(init.body)));
      return new Response(null, { status: 204 });
    }
    if (method === "PUT") {
      ensureParent(directories, path);
      files.set(path, Buffer.from(await bodyArrayBuffer(init.body)));
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && url.searchParams.get("append") === "1") {
      ensureParent(directories, path);
      const current = files.get(path) ?? Buffer.alloc(0);
      files.set(path, Buffer.concat([current, Buffer.from(await bodyArrayBuffer(init.body))]));
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      files.delete(path);
      if (url.searchParams.get("recursive") === "1") {
        const prefix = path.endsWith("/") ? path : `${path}/`;
        for (const file of Array.from(files.keys())) {
          if (file.startsWith(prefix)) {
            files.delete(file);
          }
        }
        for (const directory of Array.from(directories)) {
          if (directory === path || directory.startsWith(prefix)) {
            directories.delete(directory);
          }
        }
      }
      return new Response(null, { status: 204 });
    }
    return new Response("unsupported", { status: 405 });
  };
}

async function bodyArrayBuffer(body) {
  if (!body) {
    return new ArrayBuffer(0);
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  return Buffer.from(String(body));
}

function listMemoryNames(files, directories, path) {
  const prefix = path.endsWith("/") ? path : `${path}/`;
  const names = new Set();
  for (const file of files.keys()) {
    if (file.startsWith(prefix)) {
      const [name] = file.slice(prefix.length).split("/");
      if (name) {
        names.add(name);
      }
    }
  }
  for (const directory of directories) {
    if (directory.startsWith(prefix)) {
      const [name] = directory.slice(prefix.length).split("/");
      if (name) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

function ensureParent(directories, path) {
  const index = path.lastIndexOf("/");
  if (index > 0) {
    directories.add(path.slice(0, index));
  }
}
