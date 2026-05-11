import { join } from "node:path";
import { CorruptStorageError } from "../core/errors.js";

export type ObjectRecordKind = "json" | "binary";

export class StorageLayout {
  readonly storageDirectory: string;
  readonly channelCount: number;

  constructor(storageDirectory: string, channelCount = 1) {
    validateChannelCount(channelCount);
    this.storageDirectory = storageDirectory;
    this.channelCount = channelCount;
  }

  get snapshotsDirectory(): string {
    return join(this.storageDirectory, "snapshots");
  }

  get lazyDirectory(): string {
    return join(this.storageDirectory, "lazy");
  }

  get objectsDirectory(): string {
    return join(this.storageDirectory, "objects");
  }

  get binaryObjectsDirectory(): string {
    return join(this.storageDirectory, "objects-bin");
  }

  get currentFile(): string {
    return join(this.storageDirectory, "CURRENT");
  }

  get manifestFile(): string {
    return join(this.storageDirectory, "manifest.json");
  }

  get typeDictionaryFile(): string {
    return join(this.storageDirectory, "type-dictionary.json");
  }

  get parentIndexFile(): string {
    return join(this.storageDirectory, "parent-index.json");
  }

  get journalFile(): string {
    return join(this.storageDirectory, "journal.log");
  }

  get transactionsDirectory(): string {
    return join(this.storageDirectory, "transactions");
  }

  get walDirectory(): string {
    return join(this.storageDirectory, "wal");
  }

  get channelsDirectory(): string {
    return join(this.storageDirectory, "channels");
  }

  get lockFile(): string {
    return join(this.storageDirectory, "LOCK");
  }

  objectRecordPath(objectId: string, transactionId?: number): string {
    const fileName = transactionId ? `${objectId}.${transactionId}.json` : `${objectId}.json`;
    if (this.channelCount === 1) {
      return join(this.objectsDirectory, fileName);
    }
    return join(this.channelDirectoryFor(objectId), "objects", fileName);
  }

  binaryObjectPath(objectId: string, transactionId?: number): string {
    const fileName = transactionId ? `${objectId}.${transactionId}.bin` : `${objectId}.bin`;
    if (this.channelCount === 1) {
      return join(this.binaryObjectsDirectory, fileName);
    }
    return join(this.channelDirectoryFor(objectId), "objects-bin", fileName);
  }

  objectRecordDirectories(kind: ObjectRecordKind): string[] {
    if (this.channelCount === 1) {
      return [kind === "json" ? this.objectsDirectory : this.binaryObjectsDirectory];
    }
    return this.channelDirectories().map((directory) => join(directory, kind === "json" ? "objects" : "objects-bin"));
  }

  channelDirectories(): string[] {
    if (this.channelCount === 1) {
      return [];
    }
    return Array.from({ length: this.channelCount }, (_, index) => join(this.channelsDirectory, `ch_${index}`));
  }

  parseTransactionId(snapshotFile: string): number {
    const match = /^snapshot-(\d+)\.json$/.exec(snapshotFile);
    if (!match?.[1]) {
      throw new CorruptStorageError(`Invalid snapshot pointer "${snapshotFile}".`);
    }
    return Number(match[1]);
  }

  walPrepareFile(transactionId: number): string {
    return join(this.walDirectory, `transaction-${String(transactionId).padStart(12, "0")}.prepare.json`);
  }

  walCommitFile(transactionId: number): string {
    return join(this.walDirectory, `transaction-${String(transactionId).padStart(12, "0")}.commit.json`);
  }

  private channelDirectoryFor(objectId: string): string {
    return join(this.channelsDirectory, `ch_${this.channelIndexFor(objectId)}`);
  }

  private channelIndexFor(objectId: string): number {
    const numeric = Number(objectId);
    if (Number.isSafeInteger(numeric)) {
      return Math.abs(numeric) % this.channelCount;
    }
    let hash = 0;
    for (const char of objectId) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return hash % this.channelCount;
  }
}

function validateChannelCount(channelCount: number): void {
  if (!Number.isSafeInteger(channelCount) || channelCount < 1 || (channelCount & (channelCount - 1)) !== 0) {
    throw new RangeError("channelCount must be a positive power of two.");
  }
}
