import { join } from "node:path";
import { decodeBinaryRecord } from "../core/binary-codec.js";
import type { StorageLayout } from "./storage-layout.js";
import type {
  ObjectRecord,
  ParentIndexRecord,
  SerializedEnvelope,
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

export class StorageReader {
  constructor(
    private readonly target: StorageTarget,
    private readonly layout: StorageLayout,
  ) {}

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

  async readLatestTransactionRecord(): Promise<TransactionRecord | undefined> {
    const records = await this.readTransactionRecords();
    return records.sort((a, b) => b.transactionId - a.transactionId)[0];
  }

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

  async readDirectoryIfExists(path: string): Promise<string[]> {
    try {
      return await this.target.list(path);
    } catch {
      return [];
    }
  }
}

export function objectVersionsFromManifest(manifest: StorageManifest): Map<string, number> {
  const versions = new Map<string, number>();
  for (const objectId of manifest.objectIds) {
    versions.set(objectId, manifest.objectVersions?.[objectId] ?? manifest.transactionId);
  }
  return versions;
}

export function schemaVersionFromManifest(manifest: StorageManifest): number {
  return manifest.schemaVersion ?? 0;
}

function objectVersionsForEnvelope(envelope: SerializedEnvelope, transactionId: number): Map<string, number> {
  return new Map(Object.keys(envelope.nodes).map((objectId) => [objectId, transactionId]));
}
