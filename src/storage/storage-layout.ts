import { join } from "node:path";
import { CorruptStorageError } from "../core/errors.js";

export type ObjectRecordKind = "json" | "binary";

/** Computes canonical file and directory paths for a GraphVault storage directory. */
export class StorageLayout {
  readonly storageDirectory: string;
  readonly channelCount: number;

  /** Creates a Storage Layout with the supplied configuration. */
  constructor(storageDirectory: string, channelCount = 1) {
    validateChannelCount(channelCount);
    this.storageDirectory = storageDirectory;
    this.channelCount = channelCount;
  }

  /** Returns the resolved snapshotsDirectory path used by the storage layout. */
  get snapshotsDirectory(): string {
    return join(this.storageDirectory, "snapshots");
  }

  /** Returns the resolved lazyDirectory path used by the storage layout. */
  get lazyDirectory(): string {
    return join(this.storageDirectory, "lazy");
  }

  /** Returns the resolved objectsDirectory path used by the storage layout. */
  get objectsDirectory(): string {
    return join(this.storageDirectory, "objects");
  }

  /** Returns the resolved binaryObjectsDirectory path used by the storage layout. */
  get binaryObjectsDirectory(): string {
    return join(this.storageDirectory, "objects-bin");
  }

  /** Returns the resolved currentFile path used by the storage layout. */
  get currentFile(): string {
    return join(this.storageDirectory, "CURRENT");
  }

  /** Returns the resolved manifestFile path used by the storage layout. */
  get manifestFile(): string {
    return join(this.storageDirectory, "manifest.json");
  }

  /** Returns the resolved typeDictionaryFile path used by the storage layout. */
  get typeDictionaryFile(): string {
    return join(this.storageDirectory, "type-dictionary.json");
  }

  /** Returns the resolved parentIndexFile path used by the storage layout. */
  get parentIndexFile(): string {
    return join(this.storageDirectory, "parent-index.json");
  }

  /** Returns the resolved indexFile path used by the storage layout. */
  get indexFile(): string {
    return join(this.storageDirectory, "index.json");
  }

  /** Returns the resolved constraintFile path used by the storage layout. */
  get constraintFile(): string {
    return join(this.storageDirectory, "constraints.json");
  }

  /** Returns the resolved journalFile path used by the storage layout. */
  get journalFile(): string {
    return join(this.storageDirectory, "journal.log");
  }

  /** Returns the resolved transactionsDirectory path used by the storage layout. */
  get transactionsDirectory(): string {
    return join(this.storageDirectory, "transactions");
  }

  /** Returns the resolved walDirectory path used by the storage layout. */
  get walDirectory(): string {
    return join(this.storageDirectory, "wal");
  }

  /** Returns the resolved channelsDirectory path used by the storage layout. */
  get channelsDirectory(): string {
    return join(this.storageDirectory, "channels");
  }

  /** Returns the resolved lockFile path used by the storage layout. */
  get lockFile(): string {
    return join(this.storageDirectory, "LOCK");
  }

  /** Returns the canonical JSON object-record path for an object and optional transaction version. */
  objectRecordPath(objectId: string, transactionId?: number): string {
    const fileName = transactionId ? `${objectId}.${transactionId}.json` : `${objectId}.json`;
    if (this.channelCount === 1) {
      return join(this.objectsDirectory, fileName);
    }
    return join(this.channelDirectoryFor(objectId), "objects", fileName);
  }

  /** Returns the canonical binary object-record path for an object and optional transaction version. */
  binaryObjectPath(objectId: string, transactionId?: number): string {
    const fileName = transactionId ? `${objectId}.${transactionId}.bin` : `${objectId}.bin`;
    if (this.channelCount === 1) {
      return join(this.binaryObjectsDirectory, fileName);
    }
    return join(this.channelDirectoryFor(objectId), "objects-bin", fileName);
  }

  /** Returns every directory that may contain object records for the requested record kind. */
  objectRecordDirectories(kind: ObjectRecordKind): string[] {
    if (this.channelCount === 1) {
      return [kind === "json" ? this.objectsDirectory : this.binaryObjectsDirectory];
    }
    return this.channelDirectories().map((directory) => join(directory, kind === "json" ? "objects" : "objects-bin"));
  }

  /** Returns the channel directories used to shard object records across multiple folders. */
  channelDirectories(): string[] {
    if (this.channelCount === 1) {
      return [];
    }
    return Array.from({ length: this.channelCount }, (_, index) => join(this.channelsDirectory, `ch_${index}`));
  }

  /** Extracts the numeric transaction ID from a snapshot file name and rejects invalid pointers. */
  parseTransactionId(snapshotFile: string): number {
    const match = /^snapshot-(\d+)\.json$/.exec(snapshotFile);
    if (!match?.[1]) {
      throw new CorruptStorageError(`Invalid snapshot pointer "${snapshotFile}".`);
    }
    return Number(match[1]);
  }

  /** Returns the canonical WAL prepare file path for a transaction ID. */
  walPrepareFile(transactionId: number): string {
    return join(this.walDirectory, `transaction-${String(transactionId).padStart(12, "0")}.prepare.json`);
  }

  /** Returns the canonical WAL commit file path for a transaction ID. */
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
