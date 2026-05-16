import { join } from "node:path";
import type {
  SerializedEnvelope,
  StorageTarget,
  StorageTargetLock,
  TransactionRecord,
  TransactionMetadata,
  StoreMetadata,
  StoreMode,
} from "../core/types.js";
import { envelopeHash, transactionRecordHash } from "../core/integrity.js";
import type { StorageLayout } from "./storage-layout.js";
import type { StorageWriter } from "./storage-writer.js";
import type { ResolvedStorageWriteOptions } from "./storage-write-options.js";

/** Describes the public StorageCommitterDependencies contract. */
export interface StorageCommitterDependencies {
  target: StorageTarget;
  layout: StorageLayout;
  writer: StorageWriter;
  writeOptions: ResolvedStorageWriteOptions;
  transactionLogEnabled: () => boolean;
  validateCommit: (envelope: SerializedEnvelope, transactionId: number) => Promise<void>;
  beforePublish: () => Promise<void>;
  commitState: (transactionId: number, objectVersions: ReadonlyMap<string, number>, envelope: SerializedEnvelope) => void;
  readLatestTransactionRecord: () => Promise<TransactionRecord | undefined>;
  schemaVersion: () => number;
}

/** Describes the public CommitEnvelopeOptions contract. */
export interface CommitEnvelopeOptions {
  envelope: SerializedEnvelope;
  baseTransactionId: number;
  mode: StoreMode;
  objectIds: readonly string[];
  allObjectIds: readonly string[];
  baseObjectVersions: ReadonlyMap<string, number>;
  targetCount: number;
  lock: StorageTargetLock;
  metadata?: TransactionMetadata;
}

/** Provides the public StorageCommitter API. */
export class StorageCommitter {
  /** Creates a StorageCommitter instance. */
  constructor(private readonly dependencies: StorageCommitterDependencies) {}

  /** Runs StorageCommitter.commitEnvelope asynchronously. */
  async commitEnvelope(options: CommitEnvelopeOptions): Promise<StoreMetadata> {
    const { envelope, baseTransactionId, mode, allObjectIds, targetCount, lock } = options;
    const nextTransactionId = baseTransactionId + 1;
    const snapshotFile = snapshotName(nextTransactionId);
    const snapshotPath = join(this.dependencies.layout.snapshotsDirectory, snapshotFile);
    const objectVersions = nextObjectVersions(options.baseObjectVersions, allObjectIds, options.objectIds, nextTransactionId);
    const objectIds = objectIdsToWrite(options.baseObjectVersions, allObjectIds, options.objectIds);
    await this.dependencies.validateCommit(envelope, nextTransactionId);
    let prepareFile: string | undefined;
    if (this.dependencies.transactionLogEnabled()) {
      prepareFile = await this.dependencies.writer.writeWalPrepare({
        format: "graphvault-wal",
        version: 1,
        status: "prepared",
        transactionId: nextTransactionId,
        preparedAt: new Date().toISOString(),
        snapshotFile,
        objectIds: [...allObjectIds],
        mode,
        targetCount,
        envelope,
        schemaVersion: this.dependencies.schemaVersion(),
      });
    }

    await this.dependencies.writer.writeObjectRecords(envelope, nextTransactionId, objectIds);
    await this.dependencies.beforePublish();
    if (this.dependencies.writeOptions.writeSnapshots) {
      await this.dependencies.writer.writeJson(snapshotPath, envelope);
    }
    await lock.assertValid();
    if (prepareFile) {
      await this.dependencies.writer.writeWalCommit({
        format: "graphvault-wal",
        version: 1,
        status: "committed",
        transactionId: nextTransactionId,
        committedAt: new Date().toISOString(),
        prepareFile,
        schemaVersion: this.dependencies.schemaVersion(),
      });
    }
    const journalFile = await this.publishPreparedCommit({
      envelope,
      transactionId: nextTransactionId,
      snapshotFile,
      mode,
      targetCount,
      lock,
      objectVersions,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    });
    return {
      transactionId: nextTransactionId,
      storedAt: new Date(),
      snapshotFile,
      journalFile,
      mode,
      objectCount: targetCount,
      objectIds: [...objectIds],
      ...(options.metadata ? { metadata: options.metadata } : {}),
    };
  }

  /** Runs StorageCommitter.publishPreparedCommit asynchronously. */
  async publishPreparedCommit(options: {
    envelope: SerializedEnvelope;
    transactionId: number;
    snapshotFile: string;
    mode: StoreMode;
    targetCount: number;
    lock: StorageTargetLock;
    objectVersions?: ReadonlyMap<string, number>;
    metadata?: TransactionMetadata;
  }): Promise<string> {
    const { envelope, transactionId, snapshotFile, mode, targetCount, lock } = options;
    const objectIds = sortedObjectIds(envelope);
    const objectVersions = options.objectVersions ?? new Map(objectIds.map((objectId) => [objectId, transactionId]));
    await lock.assertValid();
    const previousTransaction = await this.dependencies.readLatestTransactionRecord();
    const existingRecord = previousTransaction?.transactionId === transactionId ? previousTransaction : undefined;
    const previousHash = previousTransaction && previousTransaction.transactionId < transactionId ? previousTransaction.transactionHash : undefined;
    const transactionRecord: TransactionRecord = existingRecord ?? {
      format: "graphvault-transaction",
      version: 1,
      transactionId,
      committedAt: new Date().toISOString(),
      snapshotFile,
      objectIds,
      mode,
      targetCount,
      ...(options.metadata ? { metadata: options.metadata } : {}),
      envelopeHash: envelopeHash(envelope),
      ...(previousHash ? { previousHash } : {}),
      schemaVersion: this.dependencies.schemaVersion(),
    };
    transactionRecord.transactionHash ??= transactionRecordHash(transactionRecord);
    const journalFile = existingRecord ? transactionRecordName(transactionId) : await this.dependencies.writer.writeTransactionRecord(transactionRecord);
    await lock.assertValid();
    await this.dependencies.writer.writeParentIndex(envelope, transactionId);
    await this.dependencies.writer.writePersistentIndex(envelope, transactionId);
    if (this.dependencies.writeOptions.writeSnapshots) {
      await lock.assertValid();
      await this.dependencies.target.writeTextAtomic(this.dependencies.layout.currentFile, snapshotFile);
    }
    await this.dependencies.writer.writeManifest(
      envelope,
      transactionId,
      objectVersions,
      transactionRecord.transactionHash,
      this.dependencies.schemaVersion(),
    );
    this.dependencies.commitState(transactionId, objectVersions, envelope);
    return journalFile;
  }
}

/** Runs the public sortedObjectIds helper. */
export function sortedObjectIds(envelope: SerializedEnvelope): string[] {
  return Object.keys(envelope.nodes).sort((a, b) => Number(a) - Number(b));
}

function snapshotName(transactionId: number): string {
  return `snapshot-${String(transactionId).padStart(12, "0")}.json`;
}

function transactionRecordName(transactionId: number): string {
  return `transaction-${String(transactionId).padStart(12, "0")}.json`;
}

function objectIdsToWrite(
  baseObjectVersions: ReadonlyMap<string, number>,
  allObjectIds: readonly string[],
  requestedObjectIds: readonly string[],
): string[] {
  const objectIds = new Set(requestedObjectIds);
  for (const objectId of allObjectIds) {
    if (!baseObjectVersions.has(objectId)) {
      objectIds.add(objectId);
    }
  }
  return [...objectIds].sort((a, b) => Number(a) - Number(b));
}

function nextObjectVersions(
  baseObjectVersions: ReadonlyMap<string, number>,
  allObjectIds: readonly string[],
  writtenObjectIds: readonly string[],
  transactionId: number,
): Map<string, number> {
  const versions = new Map<string, number>();
  const written = new Set(writtenObjectIds);
  for (const objectId of allObjectIds) {
    versions.set(objectId, written.has(objectId) || !baseObjectVersions.has(objectId) ? transactionId : baseObjectVersions.get(objectId) as number);
  }
  return versions;
}
