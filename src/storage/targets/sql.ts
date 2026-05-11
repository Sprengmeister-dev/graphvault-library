import { StorageLockError } from "../../core/errors.js";
import type { StorageLockOptions, StorageTarget, StorageTargetLock } from "../../core/types.js";

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

  async acquireLock(path: string, timeoutMs: number, options: StorageLockOptions = {}): Promise<StorageTargetLock> {
    await this.ensureSchema();
    const key = normalize(path);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        await this.client.execute(`INSERT INTO ${this.lockTableName} (path, created_at, fencing_token) VALUES (?, ?, ?)`, [
          key,
          new Date().toISOString(),
          0,
        ]);
        const fencingToken = await this.nextFencingToken(key);
        await this.client.execute(`UPDATE ${this.lockTableName} SET created_at = ?, fencing_token = ? WHERE path = ?`, [
          new Date().toISOString(),
          fencingToken,
          key,
        ]);
        return {
          fencingToken,
          assertValid: async () => {
            await this.assertLockToken(key, fencingToken);
          },
          release: async () => {
            await this.client.execute(`DELETE FROM ${this.lockTableName} WHERE path = ? AND fencing_token = ?`, [key, fencingToken]);
          },
        };
      } catch (error) {
        if (await this.removeStaleLock(key, options.staleLockTimeoutMs)) {
          continue;
        }
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
      `CREATE TABLE IF NOT EXISTS ${this.lockTableName} (path TEXT PRIMARY KEY, created_at TEXT NOT NULL, fencing_token INTEGER NOT NULL DEFAULT 0)`,
    );
    try {
      await this.client.execute(`ALTER TABLE ${this.lockTableName} ADD COLUMN fencing_token INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Existing installations may already have the column.
    }
    this.schemaReady = true;
  }

  private async withTransaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.client.transaction) {
      return this.client.transaction(work);
    }
    return work();
  }

  private async removeStaleLock(key: string, staleLockTimeoutMs: number | undefined): Promise<boolean> {
    if (!isPositiveFinite(staleLockTimeoutMs)) {
      return false;
    }
    try {
      const result = await this.client.execute(`SELECT created_at FROM ${this.lockTableName} WHERE path = ? LIMIT 1`, [key]);
      const createdAt = result.rows?.[0]?.created_at;
      if (typeof createdAt !== "string") {
        return false;
      }
      const createdAtMs = Date.parse(createdAt);
      if (!Number.isFinite(createdAtMs) || Date.now() - createdAtMs < staleLockTimeoutMs) {
        return false;
      }
      await this.client.execute(`DELETE FROM ${this.lockTableName} WHERE path = ?`, [key]);
      return true;
    } catch {
      return false;
    }
  }

  private async nextFencingToken(lockKey: string): Promise<number> {
    const counterKey = `${lockKey}.__fencing_counter`;
    const result = await this.client.execute(`SELECT fencing_token FROM ${this.lockTableName} WHERE path = ? LIMIT 1`, [counterKey]);
    const current = Number(result.rows?.[0]?.fencing_token ?? 0) || 0;
    const next = current + 1;
    await this.client.execute(`DELETE FROM ${this.lockTableName} WHERE path = ?`, [counterKey]);
    await this.client.execute(`INSERT INTO ${this.lockTableName} (path, created_at, fencing_token) VALUES (?, ?, ?)`, [
      counterKey,
      new Date().toISOString(),
      next,
    ]);
    return next;
  }

  private async assertLockToken(key: string, fencingToken: number): Promise<void> {
    const result = await this.client.execute(`SELECT fencing_token FROM ${this.lockTableName} WHERE path = ? LIMIT 1`, [key]);
    if (Number(result.rows?.[0]?.fencing_token) !== fencingToken) {
      throw new StorageLockError(`Storage lock token ${fencingToken} is no longer valid in SQL target at ${key}.`);
    }
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

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
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
