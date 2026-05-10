import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PersistentCache } from "../dist/persistent-cache.js";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "graphvault-persistent-cache-"));

try {
  const cache = await PersistentCache.start({
    storageDirectory: temporaryDirectory,
    rootFactory: () => ({ entries: new Map() }),
    types: [],
  });

  assert.equal(cache.size, 0);
  assert.equal(cache.has("missing"), false);

  await cache.set("alpha", { value: 1 });
  assert.equal(cache.size, 1);
  assert.equal(cache.has("alpha"), true);
  assert.deepEqual(cache.get("alpha"), { value: 1 });

  assert.equal(await cache.delete("beta"), false);
  assert.equal(await cache.delete("alpha"), true);
  assert.equal(cache.size, 0);

  await cache.set("gamma", 3);
  await cache.set("delta", 4);
  await cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.has("gamma"), false);

  await cache.shutdown();

  const reopened = await PersistentCache.start({
    storageDirectory: temporaryDirectory,
    rootFactory: () => ({ entries: new Map() }),
  });
  assert.equal(reopened.size, 0);
  await reopened.shutdown();
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
