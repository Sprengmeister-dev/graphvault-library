import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), "graphvault-package-smoke-"));
let tarball;

try {
  const packOutput = execFileSync("npm", ["pack", "--json", "--cache", "./.npm-cache"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [packed] = JSON.parse(packOutput);
  tarball = join(root, packed.filename);

  await writeFile(
    join(temp, "package.json"),
    JSON.stringify({ type: "module", private: true, dependencies: { "@sprengmeister/graphvault": `file:${tarball}` } }, null, 2),
  );
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(temp, ".npm-cache")], {
    cwd: temp,
    stdio: "inherit",
  });

  await writeFile(
    join(temp, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import {
  EmbeddedStorage,
  EncryptedStorageTarget,
  GraphSerializer,
  MemoryStorageTarget,
  assessStorageSafety,
  startStorage,
} from "@sprengmeister/graphvault";
import { referencedEdges } from "@sprengmeister/graphvault/internal/gvql/gvql";
import { StorageLayout } from "@sprengmeister/graphvault/internal/storage/storage-layout";
import { MemoryStorageTarget as InternalMemoryStorageTarget } from "@sprengmeister/graphvault/internal/storage/storage-target";

const target = new MemoryStorageTarget();
const storage = await EmbeddedStorage.start({
  storageDirectory: "package-smoke",
  storageTarget: target,
  rootFactory: () => ({ documents: [{ id: "doc-1", title: "Package smoke" }] }),
});
await storage.storeRoot();
const subtree = await storage.loadSubtree({ depth: 1 });
assert.equal(subtree.objectIds.length >= 2, true);
const safety = await storage.safetyProfile();
assert.equal(["production-ready", "warning", "unsafe"].includes(safety.status), true);
await storage.shutdown();

const assessed = assessStorageSafety({
  operations: {
    status: "healthy",
    storageDirectory: "package-smoke",
    readOnly: false,
    lockStrategy: "pessimistic",
    transactionLog: "full",
    lockTimeoutMs: 5000,
    staleLockTimeoutMs: 60000,
    channelCount: 1,
    publishedTransactionId: 1,
    latestJournalTransactionId: 1,
    latestWalTransactionId: 1,
    pendingWalCommits: 0,
    walPrepareFiles: 1,
    walCommitFiles: 1,
    objectCount: 1,
    latestTransactionHash: "hash",
  },
  writeProfile: "standard",
  durability: "strict",
  writeSnapshots: true,
  recoverCommittedWal: true,
  readCommittedWal: true,
  commitValidatorCount: 1,
});
assert.equal(assessed.status, "production-ready");

const encryptedRaw = new MemoryStorageTarget();
const encrypted = new EncryptedStorageTarget({ target: encryptedRaw, key: "package-smoke-key" });
await encrypted.writeTextAtomic("secure/value.txt", "secret");
assert.equal(await encrypted.readText("secure/value.txt"), "secret");
assert.equal((await encryptedRaw.readText("secure/value.txt")).includes("secret"), false);

const serializer = new GraphSerializer();
const envelope = serializer.serialize({ child: { ok: true } });
const rootNode = envelope.nodes[envelope.root.$ref];
assert.equal(referencedEdges(envelope.root.$ref, rootNode).length, 1);
assert.equal(new StorageLayout("store").manifestFile, "store/manifest.json");
assert.equal(new InternalMemoryStorageTarget() instanceof MemoryStorageTarget, true);

const viaFactory = await startStorage({
  storageDirectory: "factory-smoke",
  storageTarget: new MemoryStorageTarget(),
  rootFactory: () => ({ ok: true }),
});
await viaFactory.storeRoot();
await viaFactory.shutdown();
`,
  );
  execFileSync("node", ["smoke.mjs"], { cwd: temp, stdio: "inherit" });
  console.log("GraphVault package smoke test passed.");
} finally {
  await rm(temp, { recursive: true, force: true });
  if (tarball) {
    await rm(tarball, { force: true });
  }
}
