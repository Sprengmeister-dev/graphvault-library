import { join } from "node:path";
import type {
  SerializedEnvelope,
  StorageTarget,
  StorageTargetLock,
  StoreMetadata,
  StoreMode,
} from "../core/types.js";
import type { StorageLayout } from "./storage-layout.js";
import type { StorageWriter } from "./storage-writer.js";
import type { ResolvedStorageWriteOptions } from "./storage-write-options.js";

export interface StorageCommitterDependencies {
  target: StorageTarget;
  layout: StorageLayout;
  writer: StorageWriter;
  writeOptions: ResolvedStorageWriteOptions;
  transactionLogEnabled: () => boolean;
  validateCommit: (envelope: SerializedEnvelope, transactionId: number) => Promise<void>;
  beforePublish: () => Promise<void>;
  commitState: (transactionId: number, objectIds: readonly string[]) => void;
}

export interface CommitEnvelopeOptions {
  envelope: SerializedEnvelope;
  baseTransactionId: number;
  mode: StoreMode;
  objectIds: readonly string[];
  allObjectIds: readonly string[];
  targetCount: number;
  lock: StorageTargetLock;
}

export class StorageCommitter {
  constructor(private readonly dependencies: StorageCommitterDependencies) {}

  async commitEnvelope(options: CommitEnvelopeOptions): Promise<StoreMetadata> {
    const { envelope, baseTransactionId, mode, objectIds, allObjectIds, targetCount, lock } = options;
    const nextTransactionId = baseTransactionId + 1;
    const snapshotFile = snapshotName(nextTransactionId);
    const snapshotPath = join(this.dependencies.layout.snapshotsDirectory, snapshotFile);
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
      });
    }
    const journalFile = await this.publishPreparedCommit({
      envelope,
      transactionId: nextTransactionId,
      snapshotFile,
      mode,
      targetCount,
      lock,
    });
    return {
      transactionId: nextTransactionId,
      storedAt: new Date(),
      snapshotFile,
      journalFile,
      mode,
      objectCount: targetCount,
      objectIds: [...objectIds],
    };
  }

  async publishPreparedCommit(options: {
    envelope: SerializedEnvelope;
    transactionId: number;
    snapshotFile: string;
    mode: StoreMode;
    targetCount: number;
    lock: StorageTargetLock;
  }): Promise<string> {
    const { envelope, transactionId, snapshotFile, mode, targetCount, lock } = options;
    const objectIds = sortedObjectIds(envelope);
    await lock.assertValid();
    const journalFile = await this.dependencies.writer.writeTransactionRecord({
      format: "graphvault-transaction",
      version: 1,
      transactionId,
      committedAt: new Date().toISOString(),
      snapshotFile,
      objectIds,
      mode,
      targetCount,
    });
    await lock.assertValid();
    await this.dependencies.writer.writeParentIndex(envelope, transactionId);
    if (this.dependencies.writeOptions.writeSnapshots) {
      await lock.assertValid();
      await this.dependencies.target.writeTextAtomic(this.dependencies.layout.currentFile, snapshotFile);
    }
    await this.dependencies.writer.writeManifest(envelope, transactionId);
    this.dependencies.commitState(transactionId, objectIds);
    return journalFile;
  }
}

export function sortedObjectIds(envelope: SerializedEnvelope): string[] {
  return Object.keys(envelope.nodes).sort((a, b) => Number(a) - Number(b));
}

function snapshotName(transactionId: number): string {
  return `snapshot-${String(transactionId).padStart(12, "0")}.json`;
}
