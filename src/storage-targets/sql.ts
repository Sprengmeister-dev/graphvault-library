import { StorageLockError } from "../errors.js";
import type { StorageTarget, StorageTargetLock } from "../types.js";

export interface SqlStorageTargetOptions {
  client: SqlStorageClient;
  tableName?: string;
  lockTableName?: string;
}

export interface SqlStorageClient {
  execute(sql: string, parameters?: readonly unknown[]): Promise<SqlQueryResult>;
  transaction?<T>(work: () => Promise<T>): Promise<T>;
}

export interface SqlQueryResult {
  rows?: Array<Record<string, unknown>>;
  rowCount?: number;
}

export class SqlStorageTarget implements StorageTarget {
  private readonly client: SqlStorageClient;
  private readonly tableName: string;
  private readonly lockTableName: string;
  private schemaReady = false;

  constructor(options: SqlStorageTargetOptions) {
    this.client = options.client;
    this.tableName = quoteSqlIdentifier(options.tableName ?? "graphvault_objects");
    this.lockTableName = quoteSqlIdentifier(options.lockTableName ?? "graphvault_locks");
  }

  async ensureDirectory(path: string): Promise<void> {
    await this.writeBufferAtomic(`${path}/.dir`, Buffer.alloc(0));
  }

  async exists(path: string): Promise<boolean> {
    await this.ensureSchema();
    const key = normalize(path);
    const direct = await this.client.execute(`SELECT path FROM ${this.tableName} WHERE path = ? LIMIT 1`, [key]);
    if ((direct.rows?.length ?? 0) > 0) {
      return true;
    }
    const nested = await this.client.execute(`SELECT path FROM ${this.tableName} WHERE path LIKE ? LIMIT 1`, [`${key}/%`]);
    return (nested.rows?.length ?? 0) > 0;
  }

  async list(path: string): Promise<string[]> {
    await this.ensureSchema();
    const prefix = `${normalize(path)}/`;
    const result = await this.client.execute(`SELECT path FROM ${this.tableName} WHERE path LIKE ?`, [`${prefix}%`]);
    const names = new Set<string>();
    for (const row of result.rows ?? []) {
      const storedPath = String(row.path);
      const rest = storedPath.slice(prefix.length);
      const [name] = rest.split("/");
      if (name && name !== ".dir") {
        names.add(name);
      }
    }
    return Array.from(names).sort();
  }

  async readText(path: string): Promise<string> {
    return this.readBuffer(path).then((buffer) => buffer.toString("utf8"));
  }

  async readBuffer(path: string): Promise<Buffer> {
    await this.ensureSchema();
    const result = await this.client.execute(`SELECT body FROM ${this.tableName} WHERE path = ? LIMIT 1`, [normalize(path)]);
    const body = result.rows?.[0]?.body;
    if (body === undefined) {
      throw new Error(`No such SQL storage object: ${path}`);
    }
    return sqlBodyToBuffer(body);
  }

  async writeTextAtomic(path: string, value: string): Promise<void> {
    await this.writeBufferAtomic(path, Buffer.from(value));
  }

  async writeBufferAtomic(path: string, value: Buffer): Promise<void> {
    await this.ensureSchema();
    await this.withTransaction(async () => {
      await this.client.execute(`DELETE FROM ${this.tableName} WHERE path = ?`, [normalize(path)]);
      await this.client.execute(`INSERT INTO ${this.tableName} (path, body, updated_at) VALUES (?, ?, ?)`, [
        normalize(path),
        value,
        new Date().toISOString(),
      ]);
    });
  }

  async appendText(path: string, value: string): Promise<void> {
    let current: Buffer = Buffer.alloc(0);
    if (await this.exists(path)) {
      current = await this.readBuffer(path);
    }
    await this.writeBufferAtomic(path, Buffer.concat([current, Buffer.from(value)]));
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.ensureSchema();
    await this.client.execute(`DELETE FROM ${this.tableName} WHERE path = ?`, [normalize(path)]);
    await this.client.execute(`DELETE FROM ${this.tableName} WHERE path = ?`, [normalize(`${path}/.dir`)]);
    if (options.recursive) {
      await this.client.execute(`DELETE FROM ${this.tableName} WHERE path LIKE ?`, [`${normalize(path)}/%`]);
    }
  }

  async acquireLock(path: string, timeoutMs: number): Promise<StorageTargetLock> {
    await this.ensureSchema();
    const key = normalize(path);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        await this.client.execute(`INSERT INTO ${this.lockTableName} (path, created_at) VALUES (?, ?)`, [
          key,
          new Date().toISOString(),
        ]);
        return {
          release: async () => {
            await this.client.execute(`DELETE FROM ${this.lockTableName} WHERE path = ?`, [key]);
          },
        };
      } catch (error) {
        if (Date.now() >= deadline) {
          throw new StorageLockError(`Storage is already locked in SQL target at ${path}.`, { cause: error });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) {
      return;
    }
    await this.client.execute(
      `CREATE TABLE IF NOT EXISTS ${this.tableName} (path TEXT PRIMARY KEY, body BLOB NOT NULL, updated_at TEXT NOT NULL)`,
    );
    await this.client.execute(
      `CREATE TABLE IF NOT EXISTS ${this.lockTableName} (path TEXT PRIMARY KEY, created_at TEXT NOT NULL)`,
    );
    this.schemaReady = true;
  }

  private async withTransaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.client.transaction) {
      return this.client.transaction(work);
    }
    return work();
  }
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

function quoteSqlIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier "${identifier}".`);
  }
  return `"${identifier}"`;
}

function sqlBodyToBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "base64");
  }
  throw new Error("Unsupported SQL body value.");
}
