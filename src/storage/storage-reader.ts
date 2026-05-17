import { join } from "node:path";
import { decodeBinaryRecord } from "../core/binary-codec.js";
import type { StorageLayout } from "./storage-layout.js";
import type {
  ObjectRecord,
  ParentIndexRecord,
  SerializedEnvelope,
  StorageIndexRecord,
  StorageManifest,
  StorageTarget,
  TransactionRecord,
  WalCommitRecord,
  WalPrepareRecord,
} from "../core/types.js";

export type LoadedEnvelope =
  | { source: "manifest"; envelope: SerializedEnvelope; transactionId: number; objectVersions: Map<string, number>; schemaVersion: number }
  | { source: "snapshot"; envelope: SerializedEnvelope; transactionId: number; objectVersions: Map<string, number>; schemaVersion: number }
  | { source: "wal"; envelope: SerializedEnvelope; transactionId: number; objectVersions: Map<string, number>; schemaVersion: number };

/** Reads manifests, object records, WAL entries, indexes, and snapshots from a storage target. */
export class StorageReader {
  /** Creates a Storage Reader with the supplied configuration. */
  constructor(
    private readonly target: StorageTarget,
    private readonly layout: StorageLayout,
  ) {}

  /** Loads the newest recoverable envelope from WAL, manifest, or snapshot data. */
  async loadExistingEnvelope(options: { includeWal?: boolean } = {}): Promise<LoadedEnvelope | undefined> {
    const manifest = await this.readManifest();
    if (options.includeWal ?? true) {
      const latestWal = await this.readLatestCommittedWalEnvelope();
      if (latestWal && latestWal.transactionId > (manifest?.transactionId ?? 0)) {
        return latestWal;
      }
    }
    if (manifest) {
      try {
        const transaction = await this.readLatestTransactionRecord();
        if (transaction && transaction.transactionId > manifest.transactionId) {
          throw new Error("Manifest is behind latest committed transaction.");
        }
        return {
          source: "manifest",
          envelope: await this.envelopeFromManifest(manifest),
          transactionId: manifest.transactionId,
          objectVersions: objectVersionsFromManifest(manifest),
          schemaVersion: schemaVersionFromManifest(manifest),
        };
      } catch {
        // Fall back to the checkpoint snapshot below.
      }
    }

    const current = await this.readCurrentPointer();
    if (!current) {
      return undefined;
    }
    const content = await this.target.readText(join(this.layout.snapshotsDirectory, current));
    const envelope = JSON.parse(content) as SerializedEnvelope;
    const transactionId = this.layout.parseTransactionId(current);
    const transaction = (await this.readTransactionRecords()).find((record) => record.transactionId === transactionId);
    return {
      source: "snapshot",
      envelope,
      transactionId,
      objectVersions: objectVersionsForEnvelope(envelope, transactionId),
      schemaVersion: transaction?.schemaVersion ?? 0,
    };
  }

  private async readLatestCommittedWalEnvelope(): Promise<LoadedEnvelope | undefined> {
    const commits = await this.readCommittedWalRecords();
    for (const commit of commits.sort((a, b) => b.transactionId - a.transactionId)) {
      const prepare = await this.readWalPrepareRecord(commit.prepareFile);
      if (prepare && prepare.transactionId === commit.transactionId) {
        return {
          source: "wal",
          envelope: prepare.envelope,
          transactionId: prepare.transactionId,
          objectVersions: objectVersionsForEnvelope(prepare.envelope, prepare.transactionId),
          schemaVersion: prepare.schemaVersion ?? 0,
        };
      }
    }
    return undefined;
  }

  /** Reads the most recent transaction record from the transaction log. */
  async readLatestTransactionRecord(): Promise<TransactionRecord | undefined> {
    const records = await this.readTransactionRecords();
    return records.sort((a, b) => b.transactionId - a.transactionId)[0];
  }

  /** Reads all transaction records in transaction order. */
  async readTransactionRecords(): Promise<TransactionRecord[]> {
    const records: TransactionRecord[] = [];
    for (const file of await this.readDirectoryIfExists(this.layout.transactionsDirectory)) {
      if (!file.endsWith(".json")) {
        continue;
      }
      try {
        const record = JSON.parse(await this.target.readText(join(this.layout.transactionsDirectory, file))) as TransactionRecord;
        if (record.format === "graphvault-transaction") {
          records.push(record);
        }
      } catch {
        // Ignore incomplete transaction files; only complete records count.
      }
    }
    return records.sort((a, b) => a.transactionId - b.transactionId);
  }

  /** Reads committed WAL records that may need recovery or inspection. */
  async readCommittedWalRecords(): Promise<WalCommitRecord[]> {
    const records: WalCommitRecord[] = [];
    for (const file of await this.readDirectoryIfExists(this.layout.walDirectory)) {
      if (!file.endsWith(".commit.json")) {
        continue;
      }
      try {
        const record = JSON.parse(await this.target.readText(join(this.layout.walDirectory, file))) as WalCommitRecord;
        if (record.format === "graphvault-wal" && record.status === "committed") {
          records.push(record);
        }
      } catch {
        // Ignore incomplete WAL commit files.
      }
    }
    return records.sort((a, b) => a.transactionId - b.transactionId);
  }

  /** Reads the prepared WAL payload for a transaction ID. */
  async readWalPrepareRecord(file: string): Promise<WalPrepareRecord | undefined> {
    try {
      const record = JSON.parse(await this.target.readText(join(this.layout.walDirectory, file))) as WalPrepareRecord;
      if (record.format === "graphvault-wal" && record.status === "prepared") {
        return record;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /** Reads the CURRENT snapshot pointer, returning undefined when no store has been published. */
  async readCurrentPointer(): Promise<string | undefined> {
    try {
      if (!(await this.target.exists(this.layout.currentFile))) {
        return undefined;
      }
      const current = (await this.target.readText(this.layout.currentFile)).trim();
      return current || undefined;
    } catch {
      return undefined;
    }
  }

  /** Reads the current manifest, returning undefined for an empty store. */
  async readManifest(): Promise<StorageManifest | undefined> {
    try {
      if (!(await this.target.exists(this.layout.manifestFile))) {
        return undefined;
      }
      return JSON.parse(await this.target.readText(this.layout.manifestFile)) as StorageManifest;
    } catch {
      return undefined;
    }
  }

  /** Reads the persisted reverse parent index when present. */
  async readParentIndex(): Promise<ParentIndexRecord | undefined> {
    try {
      if (!(await this.target.exists(this.layout.parentIndexFile))) {
        return undefined;
      }
      return JSON.parse(await this.target.readText(this.layout.parentIndexFile)) as ParentIndexRecord;
    } catch {
      return undefined;
    }
  }

  /** Reads the persisted storage-wide graph index when present. */
  async readStorageIndex(): Promise<StorageIndexRecord | undefined> {
    try {
      if (!(await this.target.exists(this.layout.indexFile))) {
        return undefined;
      }
      const record = JSON.parse(await this.target.readText(this.layout.indexFile)) as StorageIndexRecord;
      return record.format === "graphvault-index" ? record : undefined;
    } catch {
      return undefined;
    }
  }

  /** Reconstructs a serialized envelope from the object records referenced by a manifest. */
  async envelopeFromManifest(manifest: StorageManifest): Promise<SerializedEnvelope> {
    const nodes: SerializedEnvelope["nodes"] = {};
    const objectVersions = objectVersionsFromManifest(manifest);
    for (const objectId of manifest.objectIds) {
      const record = await this.readObjectRecord(objectId, objectVersions.get(objectId));
      nodes[objectId] = record.node;
    }
    return {
      format: "graphvault",
      version: 1,
      createdAt: manifest.createdAt,
      root: manifest.root,
      nodes,
    };
  }

  /** Reads one persisted object record by object ID and optional transaction version. */
  async readObjectRecord(objectId: string, transactionId?: number): Promise<ObjectRecord> {
    try {
      return decodeBinaryRecord<ObjectRecord>(await this.target.readBuffer(this.layout.binaryObjectPath(objectId, transactionId)));
    } catch {
      try {
        return JSON.parse(await this.target.readText(this.layout.objectRecordPath(objectId, transactionId))) as ObjectRecord;
      } catch (error) {
        if (transactionId) {
          return this.readObjectRecord(objectId);
        }
        throw error;
      }
    }
  }

  /** Lists a directory if present and returns an empty list when it is absent. */
  async readDirectoryIfExists(path: string): Promise<string[]> {
    try {
      return await this.target.list(path);
    } catch {
      return [];
    }
  }
}

/** Reads object-version counters from a manifest, defaulting absent versions to zero. */
export function objectVersionsFromManifest(manifest: StorageManifest): Map<string, number> {
  const versions = new Map<string, number>();
  for (const objectId of manifest.objectIds) {
    versions.set(objectId, manifest.objectVersions?.[objectId] ?? manifest.transactionId);
  }
  return versions;
}

/** Reads the schema version from a manifest, treating old or empty manifests as version zero. */
export function schemaVersionFromManifest(manifest: StorageManifest): number {
  return manifest.schemaVersion ?? 0;
}

function objectVersionsForEnvelope(envelope: SerializedEnvelope, transactionId: number): Map<string, number> {
  return new Map(Object.keys(envelope.nodes).map((objectId) => [objectId, transactionId]));
}
