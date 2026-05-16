import { constants } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StorageLockError } from "../core/errors.js";
import type { StorageLockOptions, StorageTarget, StorageTargetLock } from "../core/types.js";
export { S3StorageTarget } from "./targets/s3.js";
export type {
  S3Body,
  S3ListObjectsRequest,
  S3ListObjectsResponse,
  S3ObjectRequest,
  S3PutObjectRequest,
  S3StorageClient,
  S3StorageTargetOptions,
} from "./targets/s3.js";
export { SqlStorageTarget } from "./targets/sql.js";
export type { SqlQueryResult, SqlStorageClient, SqlStorageDialect, SqlStorageTargetOptions } from "./targets/sql.js";

const ENCRYPTED_STORAGE_MAGIC = Buffer.from("GVENC1");
const ENCRYPTED_STORAGE_IV_BYTES = 12;
const ENCRYPTED_STORAGE_TAG_BYTES = 16;

/** Describes the public LocalFilesystemTargetOptions contract. */
export interface LocalFilesystemTargetOptions {
  syncWrites?: boolean;
}

/** Provides the public LocalFilesystemTarget API. */
export class LocalFilesystemTarget implements StorageTarget {
  private readonly syncWrites: boolean;

  /** Creates a LocalFilesystemTarget instance. */
  constructor(options: LocalFilesystemTargetOptions = {}) {
    this.syncWrites = options.syncWrites ?? true;
  }

  /** Runs LocalFilesystemTarget.ensureDirectory asynchronously. */
  async ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  /** Runs LocalFilesystemTarget.exists asynchronously. */
  async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Runs LocalFilesystemTarget.list asynchronously. */
  async list(path: string): Promise<string[]> {
    return readdir(path);
  }

  /** Runs LocalFilesystemTarget.readText asynchronously. */
  async readText(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  /** Runs LocalFilesystemTarget.readBuffer asynchronously. */
  async readBuffer(path: string): Promise<Buffer> {
    return readFile(path);
  }

  /** Runs LocalFilesystemTarget.writeTextAtomic asynchronously. */
  async writeTextAtomic(path: string, value: string): Promise<void> {
    await this.writeBufferAtomic(path, Buffer.from(value));
  }

  /** Runs LocalFilesystemTarget.writeBufferAtomic asynchronously. */
  async writeBufferAtomic(path: string, value: Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(tempPath, "w");
    try {
      await handle.writeFile(value);
      if (this.syncWrites) {
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
  }

  /** Runs LocalFilesystemTarget.appendText asynchronously. */
  async appendText(path: string, value: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value, { flag: "a" });
  }

  /** Runs LocalFilesystemTarget.remove asynchronously. */
  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await rm(path, { force: true, recursive: options.recursive ?? false });
  }

  /** Runs LocalFilesystemTarget.acquireLock asynchronously. */
  async acquireLock(path: string, timeoutMs: number, options: StorageLockOptions = {}): Promise<StorageTargetLock> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), fencingToken: 0 }), { flag: "wx" });
        const fencingToken = await this.nextFencingToken(path);
        await this.writeLockRecord(path, fencingToken);
        return {
          fencingToken,
          assertValid: async () => {
            await assertLocalLockToken(path, fencingToken);
          },
          release: async () => {
            await removeLocalLockIfTokenMatches(path, fencingToken);
          },
        };
      } catch (error) {
        if (await removeStaleLocalLock(path, options.staleLockTimeoutMs)) {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new StorageLockError(`Storage is already locked at ${path}.`, { cause: error });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  private async nextFencingToken(lockPath: string): Promise<number> {
    const tokenPath = `${lockPath}.fencing-token`;
    let current = 0;
    try {
      current = Number.parseInt(await readFile(tokenPath, "utf8"), 10) || 0;
    } catch {
      current = 0;
    }
    const next = current + 1;
    await this.writeTextAtomic(tokenPath, String(next));
    return next;
  }

  private async writeLockRecord(path: string, fencingToken: number): Promise<void> {
    await this.writeTextAtomic(path, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), fencingToken }));
  }
}

interface MemoryLockRecord {
  createdAtMs: number;
  fencingToken: number;
}

/** Provides the public MemoryStorageTarget API. */
export class MemoryStorageTarget implements StorageTarget {
  private readonly files = new Map<string, Buffer>();
  private readonly directories = new Set<string>();
  private readonly locks = new Map<string, MemoryLockRecord>();
  private readonly fencingTokens = new Map<string, number>();

  /** Runs MemoryStorageTarget.ensureDirectory asynchronously. */
  async ensureDirectory(path: string): Promise<void> {
    this.directories.add(normalize(path));
  }

  /** Runs MemoryStorageTarget.exists asynchronously. */
  async exists(path: string): Promise<boolean> {
    const key = normalize(path);
    return this.files.has(key) || this.directories.has(key);
  }

  /** Runs MemoryStorageTarget.list asynchronously. */
  async list(path: string): Promise<string[]> {
    const directory = normalize(path);
    const prefix = directory.endsWith("/") ? directory : `${directory}/`;
    const names = new Set<string>();
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) {
        const rest = file.slice(prefix.length);
        const [name] = rest.split("/");
        if (name) {
          names.add(name);
        }
      }
    }
    for (const item of this.directories) {
      if (item.startsWith(prefix)) {
        const rest = item.slice(prefix.length);
        const [name] = rest.split("/");
        if (name) {
          names.add(name);
        }
      }
    }
    return Array.from(names).sort();
  }

  /** Runs MemoryStorageTarget.readText asynchronously. */
  async readText(path: string): Promise<string> {
    return this.readBuffer(path).then((buffer) => buffer.toString("utf8"));
  }

  /** Runs MemoryStorageTarget.readBuffer asynchronously. */
  async readBuffer(path: string): Promise<Buffer> {
    const value = this.files.get(normalize(path));
    if (!value) {
      throw new Error(`No such file: ${path}`);
    }
    return Buffer.from(value);
  }

  /** Runs MemoryStorageTarget.writeTextAtomic asynchronously. */
  async writeTextAtomic(path: string, value: string): Promise<void> {
    await this.writeBufferAtomic(path, Buffer.from(value));
  }

  /** Runs MemoryStorageTarget.writeBufferAtomic asynchronously. */
  async writeBufferAtomic(path: string, value: Buffer): Promise<void> {
    this.ensureParent(path);
    this.files.set(normalize(path), Buffer.from(value));
  }

  /** Runs MemoryStorageTarget.appendText asynchronously. */
  async appendText(path: string, value: string): Promise<void> {
    this.ensureParent(path);
    const key = normalize(path);
    const current = this.files.get(key) ?? Buffer.alloc(0);
    this.files.set(key, Buffer.concat([current, Buffer.from(value)]));
  }

  /** Runs MemoryStorageTarget.remove asynchronously. */
  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const key = normalize(path);
    this.files.delete(key);
    this.locks.delete(key);
    if (options.recursive) {
      const prefix = key.endsWith("/") ? key : `${key}/`;
      for (const file of Array.from(this.files.keys())) {
        if (file.startsWith(prefix)) {
          this.files.delete(file);
        }
      }
      for (const directory of Array.from(this.directories)) {
        if (directory === key || directory.startsWith(prefix)) {
          this.directories.delete(directory);
        }
      }
    } else {
      this.directories.delete(key);
    }
  }

  /** Runs MemoryStorageTarget.acquireLock asynchronously. */
  async acquireLock(path: string, timeoutMs: number, options: StorageLockOptions = {}): Promise<StorageTargetLock> {
    const key = normalize(path);
    const deadline = Date.now() + timeoutMs;
    while (this.locks.has(key)) {
      if (isTimestampStale(this.locks.get(key)?.createdAtMs, options.staleLockTimeoutMs)) {
        this.locks.delete(key);
        break;
      }
      if (Date.now() >= deadline) {
        throw new StorageLockError(`Storage is already locked at ${path}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const fencingToken = (this.fencingTokens.get(key) ?? 0) + 1;
    this.fencingTokens.set(key, fencingToken);
    this.locks.set(key, { createdAtMs: Date.now(), fencingToken });
    return {
      fencingToken,
      assertValid: async () => {
        const current = this.locks.get(key);
        if (current?.fencingToken !== fencingToken) {
          throw new StorageLockError(`Storage lock token ${fencingToken} is no longer valid at ${path}.`);
        }
      },
      release: async () => {
        if (this.locks.get(key)?.fencingToken === fencingToken) {
          this.locks.delete(key);
        }
      },
    };
  }

  private ensureParent(path: string): void {
    this.directories.add(normalize(dirname(path)));
  }
}

/** Describes the public EncryptedStorageTargetOptions contract. */
export interface EncryptedStorageTargetOptions {
  target: StorageTarget;
  key: string | Buffer;
}

/** Provides the public EncryptedStorageTarget API. */
export class EncryptedStorageTarget implements StorageTarget {
  private readonly target: StorageTarget;
  private readonly key: Buffer;

  /** Creates a EncryptedStorageTarget instance. */
  constructor(options: EncryptedStorageTargetOptions) {
    this.target = options.target;
    this.key = normalizeEncryptionKey(options.key);
  }

  /** Runs EncryptedStorageTarget.ensureDirectory asynchronously. */
  async ensureDirectory(path: string): Promise<void> {
    await this.target.ensureDirectory(path);
  }

  /** Runs EncryptedStorageTarget.exists asynchronously. */
  async exists(path: string): Promise<boolean> {
    return this.target.exists(path);
  }

  /** Runs EncryptedStorageTarget.list asynchronously. */
  async list(path: string): Promise<string[]> {
    return this.target.list(path);
  }

  /** Runs EncryptedStorageTarget.readText asynchronously. */
  async readText(path: string): Promise<string> {
    return (await this.readBuffer(path)).toString("utf8");
  }

  /** Runs EncryptedStorageTarget.readBuffer asynchronously. */
  async readBuffer(path: string): Promise<Buffer> {
    return decryptStorageBuffer(await this.target.readBuffer(path), this.key);
  }

  /** Runs EncryptedStorageTarget.writeTextAtomic asynchronously. */
  async writeTextAtomic(path: string, value: string): Promise<void> {
    await this.writeBufferAtomic(path, Buffer.from(value));
  }

  /** Runs EncryptedStorageTarget.writeBufferAtomic asynchronously. */
  async writeBufferAtomic(path: string, value: Buffer): Promise<void> {
    await this.target.writeBufferAtomic(path, encryptStorageBuffer(value, this.key));
  }

  /** Runs EncryptedStorageTarget.appendText asynchronously. */
  async appendText(path: string, value: string): Promise<void> {
    const current = (await this.exists(path)) ? await this.readBuffer(path) : Buffer.alloc(0);
    await this.writeBufferAtomic(path, Buffer.concat([current, Buffer.from(value)]));
  }

  /** Runs EncryptedStorageTarget.remove asynchronously. */
  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.target.remove(path, options);
  }

  /** Runs EncryptedStorageTarget.acquireLock asynchronously. */
  async acquireLock(path: string, timeoutMs: number, options: StorageLockOptions = {}): Promise<StorageTargetLock> {
    return this.target.acquireLock(path, timeoutMs, options);
  }
}

/** Describes the public HttpStorageTargetOptions contract. */
export interface HttpStorageTargetOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/** Provides the public HttpStorageTarget API. */
export class HttpStorageTarget implements StorageTarget {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  /** Creates a HttpStorageTarget instance. */
  constructor(options: HttpStorageTargetOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Runs HttpStorageTarget.ensureDirectory asynchronously. */
  async ensureDirectory(path: string): Promise<void> {
    await this.request("PUT", path, Buffer.alloc(0), { directory: "1" });
  }

  /** Runs HttpStorageTarget.exists asynchronously. */
  async exists(path: string): Promise<boolean> {
    const response = await this.rawRequest("HEAD", path);
    return response.status >= 200 && response.status < 300;
  }

  /** Runs HttpStorageTarget.list asynchronously. */
  async list(path: string): Promise<string[]> {
    const response = await this.request("GET", path, undefined, { list: "1" });
    return (await response.json()) as string[];
  }

  /** Runs HttpStorageTarget.readText asynchronously. */
  async readText(path: string): Promise<string> {
    return this.readBuffer(path).then((buffer) => buffer.toString("utf8"));
  }

  /** Runs HttpStorageTarget.readBuffer asynchronously. */
  async readBuffer(path: string): Promise<Buffer> {
    const response = await this.request("GET", path);
    return Buffer.from(await response.arrayBuffer());
  }

  /** Runs HttpStorageTarget.writeTextAtomic asynchronously. */
  async writeTextAtomic(path: string, value: string): Promise<void> {
    await this.writeBufferAtomic(path, Buffer.from(value));
  }

  /** Runs HttpStorageTarget.writeBufferAtomic asynchronously. */
  async writeBufferAtomic(path: string, value: Buffer): Promise<void> {
    await this.request("PUT", path, value);
  }

  /** Runs HttpStorageTarget.appendText asynchronously. */
  async appendText(path: string, value: string): Promise<void> {
    await this.request("POST", path, Buffer.from(value), { append: "1" });
  }

  /** Runs HttpStorageTarget.remove asynchronously. */
  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.request("DELETE", path, undefined, options.recursive ? { recursive: "1" } : undefined);
  }

  /** Runs HttpStorageTarget.acquireLock asynchronously. */
  async acquireLock(path: string, timeoutMs: number, options: StorageLockOptions = {}): Promise<StorageTargetLock> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const response = await this.rawRequest("PUT", path, Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), fencingToken: 0 })), {
        lock: "1",
      });
      if (response.status >= 200 && response.status < 300) {
        const fencingToken = await this.nextFencingToken(path);
        await this.request("PUT", path, Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), fencingToken })));
        return {
          fencingToken,
          assertValid: async () => {
            await this.assertLockToken(path, fencingToken);
          },
          release: async () => {
            await this.removeLockIfTokenMatches(path, fencingToken);
          },
        };
      }
      if (await this.removeStaleLock(path, options.staleLockTimeoutMs)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new StorageLockError(`Storage is already locked at ${path}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async request(method: string, path: string, body?: Buffer, query?: Record<string, string>): Promise<Response> {
    const response = await this.rawRequest(method, path, body, query);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP storage target ${method} ${path} failed with ${response.status}.`);
    }
    return response;
  }

  private rawRequest(method: string, path: string, body?: Buffer, query?: Record<string, string>): Promise<Response> {
    const url = new URL(`${this.baseUrl}/${encodeURIComponent(normalize(path))}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    return this.fetchImpl(url, {
      method,
      headers: this.headers,
      ...(body ? { body } : {}),
    });
  }

  private async removeStaleLock(path: string, staleLockTimeoutMs: number | undefined): Promise<boolean> {
    if (!isPositiveFinite(staleLockTimeoutMs)) {
      return false;
    }
    try {
      const response = await this.rawRequest("GET", path);
      if (response.status < 200 || response.status >= 300) {
        return false;
      }
      if (isLockBodyStale(await response.text(), staleLockTimeoutMs)) {
        await this.remove(path);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private async nextFencingToken(lockPath: string): Promise<number> {
    const tokenPath = `${lockPath}.fencing-token`;
    let current = 0;
    try {
      const response = await this.rawRequest("GET", tokenPath);
      if (response.status >= 200 && response.status < 300) {
        current = Number.parseInt(await response.text(), 10) || 0;
      }
    } catch {
      current = 0;
    }
    const next = current + 1;
    await this.request("PUT", tokenPath, Buffer.from(String(next)));
    return next;
  }

  private async assertLockToken(path: string, fencingToken: number): Promise<void> {
    const response = await this.rawRequest("GET", path);
    if (response.status < 200 || response.status >= 300 || lockRecordFromText(await response.text()).fencingToken !== fencingToken) {
      throw new StorageLockError(`Storage lock token ${fencingToken} is no longer valid at ${path}.`);
    }
  }

  private async removeLockIfTokenMatches(path: string, fencingToken: number): Promise<void> {
    try {
      await this.assertLockToken(path, fencingToken);
      await this.remove(path);
    } catch {
      // A newer writer may already own the lock; releasing an old token must not remove it.
    }
  }
}

export async function copyStorageTargetTree(
  source: StorageTarget,
  destination: StorageTarget,
  sourceRoot: string,
  destinationRoot: string,
  options: { exclude?: (relativePath: string) => boolean } = {},
): Promise<number> {
  let filesCopied = 0;

  const copyDirectory = async (relativePath: string): Promise<void> => {
    const sourceDirectory = joinTargetPath(sourceRoot, relativePath);
    const destinationDirectory = joinTargetPath(destinationRoot, relativePath);
    await destination.ensureDirectory(destinationDirectory);
    for (const name of await listOrEmpty(source, sourceDirectory)) {
      const childRelativePath = relativePath ? `${relativePath}/${name}` : name;
      if (options.exclude?.(childRelativePath)) {
        continue;
      }
      const sourcePath = joinTargetPath(sourceRoot, childRelativePath);
      const destinationPath = joinTargetPath(destinationRoot, childRelativePath);
      try {
        await destination.writeBufferAtomic(destinationPath, await source.readBuffer(sourcePath));
        filesCopied++;
      } catch {
        await copyDirectory(childRelativePath);
      }
    }
  };

  await copyDirectory("");
  return filesCopied;
}

async function listOrEmpty(target: StorageTarget, path: string): Promise<string[]> {
  try {
    return await target.list(path);
  } catch {
    return [];
  }
}

function joinTargetPath(root: string, relativePath: string): string {
  const cleanRoot = normalize(root);
  return relativePath ? `${cleanRoot}/${relativePath}` : cleanRoot;
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

function normalizeEncryptionKey(key: string | Buffer): Buffer {
  if (typeof key === "string") {
    return createHash("sha256").update(key).digest();
  }
  if (key.length !== 32) {
    throw new Error("EncryptedStorageTarget requires a 32-byte Buffer key or a string passphrase.");
  }
  return Buffer.from(key);
}

function encryptStorageBuffer(value: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(ENCRYPTED_STORAGE_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENCRYPTED_STORAGE_MAGIC, iv, tag, encrypted]);
}

function decryptStorageBuffer(value: Buffer, key: Buffer): Buffer {
  if (!value.subarray(0, ENCRYPTED_STORAGE_MAGIC.length).equals(ENCRYPTED_STORAGE_MAGIC)) {
    throw new Error("Storage object is not encrypted with GraphVault encrypted storage format.");
  }
  const ivStart = ENCRYPTED_STORAGE_MAGIC.length;
  const tagStart = ivStart + ENCRYPTED_STORAGE_IV_BYTES;
  const encryptedStart = tagStart + ENCRYPTED_STORAGE_TAG_BYTES;
  const iv = value.subarray(ivStart, tagStart);
  const tag = value.subarray(tagStart, encryptedStart);
  const encrypted = value.subarray(encryptedStart);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

async function assertLocalLockToken(path: string, fencingToken: number): Promise<void> {
  if (lockRecordFromText(await readFile(path, "utf8")).fencingToken !== fencingToken) {
    throw new StorageLockError(`Storage lock token ${fencingToken} is no longer valid at ${path}.`);
  }
}

async function removeLocalLockIfTokenMatches(path: string, fencingToken: number): Promise<void> {
  try {
    await assertLocalLockToken(path, fencingToken);
    await rm(path, { force: true });
  } catch {
    // A newer writer may already own the lock; releasing an old token must not remove it.
  }
}

async function removeStaleLocalLock(path: string, staleLockTimeoutMs: number | undefined): Promise<boolean> {
  if (!isPositiveFinite(staleLockTimeoutMs)) {
    return false;
  }
  try {
    if (isLockBodyStale(await readFile(path, "utf8"), staleLockTimeoutMs)) {
      await rm(path, { force: true });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function isLockBodyStale(body: string, staleLockTimeoutMs: number): boolean {
  const record = lockRecordFromText(body);
  if (!record.createdAt) {
    return false;
  }
  return isTimestampStale(Date.parse(record.createdAt), staleLockTimeoutMs);
}

function lockRecordFromText(body: string): { createdAt?: string; fencingToken?: number } {
  try {
    const parsed = JSON.parse(body) as { createdAt?: unknown; fencingToken?: unknown };
    return {
      ...(typeof parsed.createdAt === "string" ? { createdAt: parsed.createdAt } : {}),
      ...(typeof parsed.fencingToken === "number" && Number.isFinite(parsed.fencingToken) ? { fencingToken: parsed.fencingToken } : {}),
    };
  } catch {
    return {};
  }
}

function isTimestampStale(createdAtMs: number | undefined, staleLockTimeoutMs: number | undefined): boolean {
  return isPositiveFinite(staleLockTimeoutMs) && typeof createdAtMs === "number" && Number.isFinite(createdAtMs) && Date.now() - createdAtMs >= staleLockTimeoutMs;
}

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
