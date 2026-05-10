import { join } from "node:path";
import { encodeBinaryRecord } from "../core/binary-codec.js";
import { buildParentIndexRecord } from "./storage-parent-index.js";
import type { StorageLayout } from "./storage-layout.js";
import type {
  ObjectRecordWriteFormat,
  ObjectRecord,
  SerializedEnvelope,
  StorageManifest,
  StorageTarget,
  TransactionRecord,
  TypeDictionaryEntry,
} from "../core/types.js";

const OBJECT_RECORD_WRITE_CONCURRENCY = 32;

export interface StorageWriterOptions {
  objectRecordFormat?: ObjectRecordWriteFormat;
  objectRecordWriteConcurrency?: number;
  prettyJson?: boolean;
}

export class StorageWriter {
  private readonly objectRecordFormat: ObjectRecordWriteFormat;
  private readonly objectRecordWriteConcurrency: number;
  private readonly prettyJson: boolean;

  constructor(
    private readonly target: StorageTarget,
    private readonly layout: StorageLayout,
    options: StorageWriterOptions = {},
  ) {
    this.objectRecordFormat = options.objectRecordFormat ?? "binary-and-json";
    this.objectRecordWriteConcurrency = options.objectRecordWriteConcurrency ?? OBJECT_RECORD_WRITE_CONCURRENCY;
    this.prettyJson = options.prettyJson ?? true;
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    const spacing = this.prettyJson ? 2 : 0;
    await this.target.writeTextAtomic(path, `${JSON.stringify(value, null, spacing)}\n`);
  }

  async writeObjectRecords(envelope: SerializedEnvelope, transactionId: number, objectIds: readonly string[]): Promise<void> {
    const storedAt = new Date().toISOString();
    await mapWithConcurrency(objectIds, this.objectRecordWriteConcurrency, async (objectId) => {
      const node = envelope.nodes[objectId];
      if (!node) {
        return;
      }
      const record: ObjectRecord = {
        format: "graphvault-object",
        version: 1,
        objectId,
        transactionId,
        storedAt,
        node,
      };
      const writes: Array<Promise<void>> = [];
      if (this.objectRecordFormat !== "json") {
        writes.push(this.target.writeBufferAtomic(this.layout.binaryObjectPath(objectId), encodeBinaryRecord(record)));
      }
      if (this.objectRecordFormat !== "binary") {
        writes.push(this.writeJson(this.layout.objectRecordPath(objectId), record));
      }
      await Promise.all(writes);
    });
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

async function mapWithConcurrency<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) {
        await fn(item);
      }
    }
  });
  await Promise.all(workers);
}
