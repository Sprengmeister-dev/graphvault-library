import assert from "node:assert/strict";
import { join } from "node:path";
import { encodeBinaryRecord } from "../dist/core/binary-codec.js";
import { envelopeHash, transactionHashPayload, transactionRecordHash } from "../dist/core/integrity.js";
import { StorageLayout } from "../dist/storage/storage-layout.js";
import { StorageReader } from "../dist/storage/storage-reader.js";
import { verifyStorage } from "../dist/storage/storage-verifier.js";

const layout = new StorageLayout("store");
const envelope = {
  format: "graphvault",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  root: { $ref: "1" },
  nodes: {
    1: { kind: "object", props: { child: { $ref: "2" }, missing: { $ref: "404" } } },
    2: { kind: "lazy", key: "blob/a" },
  },
};
const manifest = {
  format: "graphvault-manifest",
  transactionId: 2,
  schemaVersion: 1,
  createdAt: envelope.createdAt,
  root: envelope.root,
  objectIds: ["1", "2"],
  objectVersions: { 1: 1, 2: 2 },
};
const transactionOne = transaction(1, "snapshot-000000000001.json", undefined, 1);
const transactionTwo = transaction(2, "snapshot-000000000002.json", transactionOne.transactionHash, 1);

const files = new Map([
  [layout.currentFile, "snapshot-000000000002.json\n"],
  [layout.manifestFile, JSON.stringify(manifest)],
  [layout.parentIndexFile, JSON.stringify({ format: "graphvault-parent-index", version: 1, parents: {} })],
  [layout.indexFile, JSON.stringify({ format: "graphvault-index", transactionId: 1, nodeCount: 99, envelopeHash: "wrong" })],
  [join(layout.snapshotsDirectory, "snapshot-000000000002.json"), JSON.stringify(envelope)],
  [layout.objectRecordPath("1", 1), JSON.stringify({ objectId: "1", transactionId: 1, node: envelope.nodes[1] })],
  [layout.objectRecordPath("2"), JSON.stringify({ objectId: "2", transactionId: 2, node: envelope.nodes[2] })],
  [layout.binaryObjectPath("1"), encodeBinaryRecord({ objectId: "1", transactionId: 1, node: envelope.nodes[1] })],
  [join(layout.transactionsDirectory, "transaction-000000000001.json"), JSON.stringify(transactionOne)],
  [join(layout.transactionsDirectory, "transaction-000000000002.json"), JSON.stringify(transactionTwo)],
  [join(layout.transactionsDirectory, "broken.json"), "{"],
  [join(layout.transactionsDirectory, "note.txt"), "ignored"],
  [join(layout.walDirectory, "transaction-000000000003.prepare.json"), JSON.stringify({
    format: "graphvault-wal",
    status: "prepared",
    transactionId: 3,
    schemaVersion: 2,
    envelope,
  })],
  [join(layout.walDirectory, "transaction-000000000003.commit.json"), JSON.stringify({
    format: "graphvault-wal",
    status: "committed",
    transactionId: 3,
    schemaVersion: 3,
    prepareFile: "transaction-000000000003.prepare.json",
  })],
  [join(layout.walDirectory, "bad.commit.json"), "{"],
  [join(layout.walDirectory, "invalid.commit.json"), JSON.stringify({ format: "nope", status: "open" })],
  [join(layout.walDirectory, "missing.commit.json"), JSON.stringify({
    format: "graphvault-wal",
    status: "committed",
    transactionId: 4,
    prepareFile: "missing.prepare.json",
  })],
]);
const target = mapTarget(files);
const reader = new StorageReader(target, layout);

assert.equal((await reader.readLatestTransactionRecord()).transactionId, 2);
assert.equal((await reader.readTransactionRecords()).length, 2);
assert.equal((await reader.readCommittedWalRecords()).length, 2);
assert.equal(await reader.readWalPrepareRecord("missing.prepare.json"), undefined);
assert.equal(await reader.readWalPrepareRecord("transaction-000000000003.commit.json"), undefined);
assert.equal(await reader.readCurrentPointer(), "snapshot-000000000002.json");
assert.equal((await reader.readManifest()).transactionId, 2);
assert.equal((await reader.readParentIndex()).format, "graphvault-parent-index");
assert.equal((await reader.readStorageIndex()).format, "graphvault-index");
assert.equal((await reader.envelopeFromManifest(manifest)).nodes[1].kind, "object");
assert.equal((await reader.readObjectRecord("1")).objectId, "1");
assert.equal((await reader.readObjectRecord("2", 99)).objectId, "2");
assert.equal((await reader.readDirectoryIfExists("missing")).length, 0);

const walLoaded = await reader.loadExistingEnvelope();
assert.equal(walLoaded.source, "wal");
assert.equal(walLoaded.transactionId, 3);
const manifestLoaded = await reader.loadExistingEnvelope({ includeWal: false });
assert.equal(manifestLoaded.source, "manifest");

const snapshotReader = new StorageReader(mapTarget(new Map([
  [layout.currentFile, "snapshot-000000000002.json"],
  [join(layout.snapshotsDirectory, "snapshot-000000000002.json"), JSON.stringify(envelope)],
  [join(layout.transactionsDirectory, "transaction-000000000002.json"), JSON.stringify(transactionTwo)],
])), layout);
assert.equal((await snapshotReader.loadExistingEnvelope()).source, "snapshot");
assert.equal(await new StorageReader(mapTarget(new Map()), layout).loadExistingEnvelope(), undefined);

const missingManifestVerification = await verifyStorage({
  target,
  lazyDirectory: layout.lazyDirectory,
  walDirectory: layout.walDirectory,
  readManifest: async () => undefined,
  readLatestTransactionRecord: async () => undefined,
  readObjectRecord: async () => {
    throw new Error("unused");
  },
});
assert.equal(missingManifestVerification.ok, false);
assert.equal(missingManifestVerification.pendingWalCommits, 1);
assert.equal(missingManifestVerification.warnings.some((warning) => warning.includes("committed WAL recovery")), true);

const verification = await verifyStorage({
  target,
  lazyDirectory: layout.lazyDirectory,
  walDirectory: layout.walDirectory,
  readManifest: async () => ({ ...manifest, schemaVersion: -1, latestTransactionHash: "wrong" }),
  readLatestTransactionRecord: async () => ({ ...transactionTwo, transactionId: 5 }),
  readTransactionRecords: async () => [{ ...transactionOne, schemaVersion: -1 }, { ...transactionTwo, previousHash: "wrong" }],
  readObjectRecord: async (objectId) => (
    objectId === "1"
      ? { objectId: "mismatch", transactionId: 1, node: envelope.nodes[1] }
      : { objectId, transactionId: 2, node: envelope.nodes[2] }
  ),
  readStorageIndex: async () => ({ format: "bad", transactionId: 1, nodeCount: 99, envelopeHash: "wrong" }),
  readSnapshotEnvelope: async () => ({ ...envelope, nodes: {} }),
});
assert.equal(verification.ok, false);
assert.equal(verification.errors.some((error) => error.includes("schemaVersion")), true);
assert.equal(verification.errors.some((error) => error.includes("mismatched objectId")), true);
assert.equal(verification.errors.some((error) => error.includes("referenced but not listed")), true);
assert.equal(verification.errors.some((error) => error.includes("Lazy file")), true);
assert.equal(verification.warnings.some((warning) => warning.includes("Persistent index")), true);

function mapTarget(records) {
  return {
    async exists(path) {
      return records.has(path);
    },
    async readText(path) {
      const value = records.get(path);
      if (typeof value !== "string") throw new Error(`Missing text ${path}`);
      return value;
    },
    async readBuffer(path) {
      const value = records.get(path);
      if (!(value instanceof Uint8Array)) throw new Error(`Missing buffer ${path}`);
      return value;
    },
    async list(path) {
      const prefix = `${path}/`;
      const children = [...records.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .filter((key) => !key.includes("/"));
      if (children.length === 0) throw new Error(`Missing directory ${path}`);
      return children;
    },
  };
}

function transaction(transactionId, snapshotFile, previousHash, schemaVersion) {
  const base = {
    format: "graphvault-transaction",
    transactionId,
    parentTransactionId: transactionId - 1,
    committedAt: "2026-01-01T00:00:00.000Z",
    snapshotFile,
    targetCount: Object.keys(envelope.nodes).length,
    objectIds: Object.keys(envelope.nodes),
    schemaVersion,
    envelopeHash: envelopeHash(envelope),
    previousHash,
  };
  return { ...base, transactionHash: transactionRecordHash(transactionHashPayload(base)) };
}
