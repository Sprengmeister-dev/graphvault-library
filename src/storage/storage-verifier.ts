import { join } from "node:path";
import type {
  ObjectRecord,
  SerializedEnvelope,
  StorageIndexRecord,
  StorageManifest,
  StorageTarget,
  TransactionRecord,
  VerificationResult,
  WalCommitRecord,
  WalPrepareRecord,
} from "../core/types.js";
import { envelopeHash, transactionHashPayload, transactionRecordHash } from "../core/integrity.js";
import { objectVersionsFromManifest } from "./storage-reader.js";
import { indexEnvelopeHash } from "./storage-index.js";

export interface StorageVerifierOptions {
  target: StorageTarget;
  lazyDirectory: string;
  walDirectory?: string;
  readManifest: () => Promise<StorageManifest | undefined>;
  readLatestTransactionRecord: () => Promise<TransactionRecord | undefined>;
  readTransactionRecords?: () => Promise<TransactionRecord[]>;
  readObjectRecord: (objectId: string, transactionId?: number) => Promise<ObjectRecord>;
  readStorageIndex?: () => Promise<StorageIndexRecord | undefined>;
  readSnapshotEnvelope?: (snapshotFile: string) => Promise<import("../core/types.js").SerializedEnvelope>;
}

export async function verifyStorage(options: StorageVerifierOptions): Promise<VerificationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let checkedObjects = 0;
  let checkedTransactions = 0;
  let checkedWalRecords = 0;
  let checkedIntegrityHashes = 0;
  let pendingWalCommits = 0;

  const manifest = await options.readManifest();
  if (!manifest) {
    if (options.walDirectory) {
      const wal = await verifyWal(options.target, options.walDirectory, 0);
      checkedWalRecords = wal.checkedWalRecords;
      pendingWalCommits = wal.pendingWalCommits;
      warnings.push(...wal.warnings);
      errors.push(...wal.errors);
    }
    if (pendingWalCommits === 0) {
      errors.push("Missing or unreadable manifest.json.");
    } else {
      warnings.push("Manifest is missing, but committed WAL recovery data is available.");
    }
    return { ok: errors.length === 0, checkedObjects, checkedTransactions, checkedWalRecords, checkedIntegrityHashes, pendingWalCommits, warnings, errors };
  }

  if (options.walDirectory) {
    const wal = await verifyWal(options.target, options.walDirectory, manifest.transactionId);
    checkedWalRecords = wal.checkedWalRecords;
    pendingWalCommits = wal.pendingWalCommits;
    warnings.push(...wal.warnings);
    errors.push(...wal.errors);
  }
  if (manifest.schemaVersion !== undefined && !isNonNegativeSafeInteger(manifest.schemaVersion)) {
    errors.push("Manifest schemaVersion must be a non-negative safe integer.");
  }

  const latestTransaction = await options.readLatestTransactionRecord();
  if (latestTransaction) {
    checkedTransactions++;
    if (latestTransaction.transactionId > manifest.transactionId) {
      if (pendingWalCommits > 0) {
        warnings.push(
          `Manifest transaction ${manifest.transactionId} is behind latest transaction ${latestTransaction.transactionId}, but committed WAL recovery data is available.`,
        );
      } else {
        errors.push(`Manifest transaction ${manifest.transactionId} is behind latest transaction ${latestTransaction.transactionId}.`);
      }
    }
  }
  const transactionIntegrity = await verifyTransactionIntegrity(options, manifest);
  checkedTransactions = Math.max(checkedTransactions, transactionIntegrity.checkedTransactions);
  checkedIntegrityHashes = transactionIntegrity.checkedIntegrityHashes;
  warnings.push(...transactionIntegrity.warnings);
  errors.push(...transactionIntegrity.errors);

  const knownObjects = new Set(manifest.objectIds);
  const objectVersions = objectVersionsFromManifest(manifest);
  const nodes: SerializedEnvelope["nodes"] = {};
  const referencedObjects = new Set<string>();
  const referencedLazyFiles = new Set<string>();
  if (manifest.root && typeof manifest.root === "object" && "$ref" in manifest.root) {
    referencedObjects.add(manifest.root.$ref);
  }

  for (const objectId of manifest.objectIds) {
    let record: ObjectRecord;
    try {
      record = await options.readObjectRecord(objectId, objectVersions.get(objectId));
      checkedObjects++;
    } catch {
      errors.push(`Missing or unreadable object record ${objectId}.`);
      continue;
    }
    if (record.objectId !== objectId) {
      errors.push(`Object record ${objectId} contains mismatched objectId ${record.objectId}.`);
    }
    nodes[objectId] = record.node;
    collectReferences(record.node, referencedObjects, referencedLazyFiles);
  }

  for (const objectId of referencedObjects) {
    if (!knownObjects.has(objectId)) {
      errors.push(`Object ${objectId} is referenced but not listed in manifest.`);
    }
  }

  for (const lazyFile of referencedLazyFiles) {
    if (!(await options.target.exists(join(options.lazyDirectory, lazyFile)))) {
      errors.push(`Lazy file ${lazyFile} is referenced but missing.`);
    }
  }

  if (options.readStorageIndex) {
    const index = await options.readStorageIndex();
    if (!index) {
      warnings.push("Persistent index is missing; GVQL can rebuild ephemeral indexes but persistent index acceleration is unavailable.");
    } else {
      verifyPersistentIndex(index, manifest, nodes, warnings);
    }
  }

  return { ok: errors.length === 0, checkedObjects, checkedTransactions, checkedWalRecords, checkedIntegrityHashes, pendingWalCommits, warnings, errors };
}

function verifyPersistentIndex(index: StorageIndexRecord, manifest: StorageManifest, nodes: SerializedEnvelope["nodes"], warnings: string[]): void {
  if (index.format !== "graphvault-index") {
    warnings.push("Persistent index has an invalid format; GVQL will rebuild ephemeral indexes if needed.");
  }
  if (index.transactionId !== manifest.transactionId) {
    warnings.push(`Persistent index transaction ${index.transactionId} does not match manifest transaction ${manifest.transactionId}.`);
  }
  if (index.nodeCount !== manifest.objectIds.length) {
    warnings.push(`Persistent index node count ${index.nodeCount} does not match manifest object count ${manifest.objectIds.length}.`);
  }
  const envelope: SerializedEnvelope = {
    format: "graphvault",
    version: 1,
    createdAt: manifest.createdAt,
    root: manifest.root,
    nodes,
  };
  if (index.envelopeHash !== indexEnvelopeHash(envelope)) {
    warnings.push("Persistent index envelopeHash does not match the manifest graph.");
  }
}

async function verifyTransactionIntegrity(
  options: StorageVerifierOptions,
  manifest: StorageManifest,
): Promise<{ checkedTransactions: number; checkedIntegrityHashes: number; warnings: string[]; errors: string[] }> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const records = options.readTransactionRecords ? await options.readTransactionRecords() : [];
  let checkedIntegrityHashes = 0;
  let previousHash: string | undefined;
  for (const record of records.sort((a, b) => a.transactionId - b.transactionId)) {
    if (record.schemaVersion !== undefined && !isNonNegativeSafeInteger(record.schemaVersion)) {
      errors.push(`Transaction ${record.transactionId} has an invalid schemaVersion.`);
    }
    if (record.previousHash || record.transactionHash) {
      if (record.previousHash !== previousHash) {
        errors.push(`Transaction ${record.transactionId} has an invalid previousHash.`);
      }
      if (!record.transactionHash) {
        errors.push(`Transaction ${record.transactionId} is missing transactionHash.`);
      } else {
        const expected = transactionRecordHash(transactionHashPayload(record));
        checkedIntegrityHashes++;
        if (record.transactionHash !== expected) {
          errors.push(`Transaction ${record.transactionId} has an invalid transactionHash.`);
        }
      }
    }
    if (record.envelopeHash && options.readSnapshotEnvelope) {
      try {
        const snapshotHash = envelopeHash(await options.readSnapshotEnvelope(record.snapshotFile));
        checkedIntegrityHashes++;
        if (record.envelopeHash !== snapshotHash) {
          errors.push(`Transaction ${record.transactionId} envelopeHash does not match ${record.snapshotFile}.`);
        }
      } catch {
        // Snapshot-free write profiles are valid; object-record verification still covers the live manifest.
      }
    }
    previousHash = record.transactionHash ?? previousHash;
  }
  const publishedRecord = records.find((record) => record.transactionId === manifest.transactionId);
  if (manifest.latestTransactionHash && publishedRecord?.transactionHash && manifest.latestTransactionHash !== publishedRecord.transactionHash) {
    errors.push(`Manifest latestTransactionHash does not match transaction ${publishedRecord.transactionId}.`);
  }
  if (
    manifest.schemaVersion !== undefined &&
    publishedRecord?.schemaVersion !== undefined &&
    manifest.schemaVersion !== publishedRecord.schemaVersion
  ) {
    errors.push(`Manifest schemaVersion does not match transaction ${publishedRecord.transactionId}.`);
  }
  if (manifest.latestTransactionHash) {
    checkedIntegrityHashes++;
  }
  const latest = records.at(-1);
  if (records.length > 0 && !latest?.transactionHash) {
    warnings.push("Latest transaction record has no transactionHash; integrity-chain verification is limited for legacy data.");
  }
  return { checkedTransactions: records.length, checkedIntegrityHashes, warnings, errors };
}

async function verifyWal(
  target: StorageTarget,
  walDirectory: string,
  manifestTransactionId: number,
): Promise<{ checkedWalRecords: number; pendingWalCommits: number; warnings: string[]; errors: string[] }> {
  let checkedWalRecords = 0;
  let pendingWalCommits = 0;
  const warnings: string[] = [];
  const errors: string[] = [];
  const files = await listOrEmpty(target, walDirectory);
  const prepareFiles = new Set(files.filter((file) => file.endsWith(".prepare.json")));
  for (const file of files) {
    if (!file.endsWith(".commit.json")) {
      continue;
    }
    checkedWalRecords++;
    let commit: WalCommitRecord;
    try {
      commit = JSON.parse(await target.readText(join(walDirectory, file))) as WalCommitRecord;
    } catch {
      errors.push(`Unreadable WAL commit record ${file}.`);
      continue;
    }
    if (commit.format !== "graphvault-wal" || commit.status !== "committed") {
      errors.push(`Invalid WAL commit record ${file}.`);
      continue;
    }
    if (!prepareFiles.has(commit.prepareFile)) {
      errors.push(`WAL commit ${file} references missing prepare record ${commit.prepareFile}.`);
      continue;
    }
    checkedWalRecords++;
    let prepare: WalPrepareRecord;
    try {
      prepare = JSON.parse(await target.readText(join(walDirectory, commit.prepareFile))) as WalPrepareRecord;
    } catch {
      errors.push(`Unreadable WAL prepare record ${commit.prepareFile}.`);
      continue;
    }
    if (prepare.format !== "graphvault-wal" || prepare.status !== "prepared" || prepare.transactionId !== commit.transactionId) {
      errors.push(`Invalid WAL prepare record ${commit.prepareFile}.`);
    }
    if (prepare.schemaVersion !== undefined && !isNonNegativeSafeInteger(prepare.schemaVersion)) {
      errors.push(`WAL prepare ${commit.prepareFile} has an invalid schemaVersion.`);
    }
    if (commit.schemaVersion !== undefined && !isNonNegativeSafeInteger(commit.schemaVersion)) {
      errors.push(`WAL commit ${file} has an invalid schemaVersion.`);
    }
    if (prepare.schemaVersion !== commit.schemaVersion) {
      errors.push(`WAL commit ${file} schemaVersion does not match ${commit.prepareFile}.`);
    }
    if (commit.transactionId > manifestTransactionId) {
      pendingWalCommits++;
      warnings.push(`Committed WAL transaction ${commit.transactionId} is newer than manifest transaction ${manifestTransactionId}; recovery can publish it.`);
    }
  }
  return { checkedWalRecords, pendingWalCommits, warnings, errors };
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

async function listOrEmpty(target: StorageTarget, path: string): Promise<string[]> {
  try {
    return await target.list(path);
  } catch {
    return [];
  }
}

function collectReferences(node: ObjectRecord["node"], objectRefs: Set<string>, lazyFiles: Set<string>): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }
    if ("$ref" in value && typeof value.$ref === "string") {
      objectRefs.add(value.$ref);
      return;
    }
    if ("$type" in value) {
      return;
    }
  };

  switch (node.kind) {
    case "array":
      for (const item of node.items) {
        visit(item);
      }
      break;
    case "map":
      for (const [key, value] of node.entries) {
        visit(key);
        visit(value);
      }
      break;
    case "set":
      for (const item of node.items) {
        visit(item);
      }
      break;
    case "object":
      for (const value of Object.values(node.props)) {
        visit(value);
      }
      for (const [key, value] of node.symbolProps ?? []) {
        visit(key);
        visit(value);
      }
      break;
    case "lazy":
      lazyFiles.add(`${encodeURIComponent(node.key)}.json`);
      break;
  }
}
