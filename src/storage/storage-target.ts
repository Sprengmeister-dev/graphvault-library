import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StorageLockError } from "../core/errors.js";
import type { StorageTarget, StorageTargetLock } from "../core/types.js";
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
export type { SqlQueryResult, SqlStorageClient, SqlStorageTargetOptions } from "./targets/sql.js";

export interface LocalFilesystemTargetOptions {
  syncWrites?: boolean;
}

export class LocalFilesystemTarget implements StorageTarget {
  private readonly syncWrites: boolean;

  constructor(options: LocalFilesystemTargetOptions = {}) {
    this.syncWrites = options.syncWrites ?? true;
  }

  async ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async list(path: string): Promise<string[]> {
    return readdir(path);
  }

  async readText(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async readBuffer(path: string): Promise<Buffer> {
    return readFile(path);
  }

  async writeTextAtomic(path: string, value: string): Promise<void> {
    await this.writeBufferAtomic(path, Buffer.from(value));
  }

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

  async appendText(path: string, value: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value, { flag: "a" });
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await rm(path, { force: true, recursive: options.recursive ?? false });
  }

  async acquireLock(path: string, timeoutMs: number): Promise<StorageTargetLock> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        const handle = await open(path, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        return {
          release: async () => {
            await handle.close();
            await rm(path, { force: true });
          },
        };
      } catch (error) {
        if (Date.now() >= deadline) {
          throw new StorageLockError(`Storage is already locked at ${path}.`, { cause: error });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

export class MemoryStorageTarget implements StorageTarget {
  private readonly files = new Map<string, Buffer>();
  private readonly directories = new Set<string>();
  private readonly locks = new Set<string>();

  async ensureDirectory(path: string): Promise<void> {
    this.directories.add(normalize(path));
  }

  async exists(path: string): Promise<boolean> {
    const key = normalize(path);
    return this.files.has(key) || this.directories.has(key);
  }

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

  async readText(path: string): Promise<string> {
    return this.readBuffer(path).then((buffer) => buffer.toString("utf8"));
  }

  async readBuffer(path: string): Promise<Buffer> {
    const value = this.files.get(normalize(path));
    if (!value) {
      throw new Error(`No such file: ${path}`);
    }
    return Buffer.from(value);
  }

  async writeTextAtomic(path: string, value: string): Promise<void> {
    await this.writeBufferAtomic(path, Buffer.from(value));
  }

  async writeBufferAtomic(path: string, value: Buffer): Promise<void> {
    this.ensureParent(path);
    this.files.set(normalize(path), Buffer.from(value));
  }

  async appendText(path: string, value: string): Promise<void> {
    this.ensureParent(path);
    const key = normalize(path);
    const current = this.files.get(key) ?? Buffer.alloc(0);
    this.files.set(key, Buffer.concat([current, Buffer.from(value)]));
  }

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

  async acquireLock(path: string, timeoutMs: number): Promise<StorageTargetLock> {
    const key = normalize(path);
    const deadline = Date.now() + timeoutMs;
    while (this.locks.has(key)) {
      if (Date.now() >= deadline) {
        throw new StorageLockError(`Storage is already locked at ${path}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.locks.add(key);
    return {
      release: async () => {
        this.locks.delete(key);
      },
    };
  }

  private ensureParent(path: string): void {
    this.directories.add(normalize(dirname(path)));
  }
}

export interface HttpStorageTargetOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export class HttpStorageTarget implements StorageTarget {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpStorageTargetOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? fetch;
  }

  async ensureDirectory(path: string): Promise<void> {
    await this.request("PUT", path, Buffer.alloc(0), { directory: "1" });
  }

  async exists(path: string): Promise<boolean> {
    const response = await this.rawRequest("HEAD", path);
    return response.status >= 200 && response.status < 300;
  }

  async list(path: string): Promise<string[]> {
    const response = await this.request("GET", path, undefined, { list: "1" });
    return (await response.json()) as string[];
  }

  async readText(path: string): Promise<string> {
    return this.readBuffer(path).then((buffer) => buffer.toString("utf8"));
  }

  async readBuffer(path: string): Promise<Buffer> {
    const response = await this.request("GET", path);
    return Buffer.from(await response.arrayBuffer());
  }

  async writeTextAtomic(path: string, value: string): Promise<void> {
    await this.writeBufferAtomic(path, Buffer.from(value));
  }

  async writeBufferAtomic(path: string, value: Buffer): Promise<void> {
    await this.request("PUT", path, value);
  }

  async appendText(path: string, value: string): Promise<void> {
    await this.request("POST", path, Buffer.from(value), { append: "1" });
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.request("DELETE", path, undefined, options.recursive ? { recursive: "1" } : undefined);
  }

  async acquireLock(path: string, timeoutMs: number): Promise<StorageTargetLock> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const response = await this.rawRequest("PUT", path, Buffer.from(JSON.stringify({ createdAt: new Date().toISOString() })), {
        lock: "1",
      });
      if (response.status >= 200 && response.status < 300) {
        return {
          release: async () => {
            await this.remove(path);
          },
        };
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
}

export async function copyStorageTargetTree(
  source: StorageTarget,
  destination: StorageTarget,
  sourceRoot: string,
  destinationRoot: string,
): Promise<number> {
  let filesCopied = 0;

  const copyDirectory = async (relativePath: string): Promise<void> => {
    const sourceDirectory = joinTargetPath(sourceRoot, relativePath);
    const destinationDirectory = joinTargetPath(destinationRoot, relativePath);
    await destination.ensureDirectory(destinationDirectory);
    for (const name of await listOrEmpty(source, sourceDirectory)) {
      const childRelativePath = relativePath ? `${relativePath}/${name}` : name;
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
