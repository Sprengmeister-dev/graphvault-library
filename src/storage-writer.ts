import { join } from "node:path";
import { encodeBinaryRecord } from "./binary-codec.js";
import { buildParentIndexRecord } from "./storage-parent-index.js";
import type { StorageLayout } from "./storage-layout.js";
import type {
  ObjectRecord,
  SerializedEnvelope,
  StorageManifest,
  StorageTarget,
  TransactionRecord,
  TypeDictionaryEntry,
} from "./types.js";

export class StorageWriter {
  constructor(
    private readonly target: StorageTarget,
    private readonly layout: StorageLayout,
  ) {}

  async writeJson(path: string, value: unknown): Promise<void> {
    await this.target.writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  async writeObjectRecords(envelope: SerializedEnvelope, transactionId: number, objectIds: readonly string[]): Promise<void> {
    const storedAt = new Date().toISOString();
    for (const objectId of objectIds) {
      const node = envelope.nodes[objectId];
      if (!node) {
        continue;
      }
      const record: ObjectRecord = {
        format: "graphvault-object",
        version: 1,
        objectId,
        transactionId,
        storedAt,
        node,
      };
      await this.target.writeBufferAtomic(this.layout.binaryObjectPath(objectId), encodeBinaryRecord(record));
      await this.writeJson(this.layout.objectRecordPath(objectId), record);
    }
  }

  async writeManifest(envelope: SerializedEnvelope, transactionId: number): Promise<void> {
    await this.writeJson(this.layout.manifestFile, {
      format: "graphvault-manifest",
      version: 1,
      transactionId,
      createdAt: new Date().toISOString(),
      root: envelope.root,
      objectIds: Object.keys(envelope.nodes).sort((a, b) => Number(a) - Number(b)),
    } satisfies StorageManifest);
  }

  async writeParentIndex(envelope: SerializedEnvelope, transactionId: number): Promise<void> {
    await this.writeJson(this.layout.parentIndexFile, buildParentIndexRecord(envelope, transactionId));
  }

  async writeTransactionRecord(record: TransactionRecord): Promise<string> {
    const journalFile = `transaction-${String(record.transactionId).padStart(12, "0")}.json`;
    await this.writeJson(join(this.layout.transactionsDirectory, journalFile), record);
    await this.target.appendText(this.layout.journalFile, `${JSON.stringify(record)}\n`);
    return journalFile;
  }

  async writeTypeDictionary(types: TypeDictionaryEntry[]): Promise<void> {
    await this.writeJson(this.layout.typeDictionaryFile, {
      format: "graphvault-type-dictionary",
      version: 1,
      types,
    });
  }
}
