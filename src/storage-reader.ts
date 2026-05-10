import { join } from "node:path";
import { decodeBinaryRecord } from "./binary-codec.js";
import type { StorageLayout } from "./storage-layout.js";
import type { ObjectRecord, ParentIndexRecord, SerializedEnvelope, StorageManifest, StorageTarget, TransactionRecord } from "./types.js";

export type LoadedEnvelope =
  | { source: "manifest"; envelope: SerializedEnvelope; transactionId: number }
  | { source: "snapshot"; envelope: SerializedEnvelope; transactionId: number };

export class StorageReader {
  constructor(
    private readonly target: StorageTarget,
    private readonly layout: StorageLayout,
  ) {}

  async loadExistingEnvelope(): Promise<LoadedEnvelope | undefined> {
    const manifest = await this.readManifest();
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
    return {
      source: "snapshot",
      envelope: JSON.parse(content) as SerializedEnvelope,
      transactionId: this.layout.parseTransactionId(current),
    };
  }

  async readLatestTransactionRecord(): Promise<TransactionRecord | undefined> {
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
    return records.sort((a, b) => b.transactionId - a.transactionId)[0];
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
    for (const objectId of manifest.objectIds) {
      const record = await this.readObjectRecord(objectId);
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

  async readObjectRecord(objectId: string): Promise<ObjectRecord> {
    try {
      return decodeBinaryRecord<ObjectRecord>(await this.target.readBuffer(this.layout.binaryObjectPath(objectId)));
    } catch {
      return JSON.parse(await this.target.readText(this.layout.objectRecordPath(objectId))) as ObjectRecord;
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
