import { StorageLockError } from "../../core/errors.js";
import type { StorageLockOptions, StorageTarget, StorageTargetLock } from "../../core/types.js";

/** Bucket, prefix, client, and lock settings for the S3-compatible storage target. */
export interface S3StorageTargetOptions {
  bucket: string;
  prefix?: string;
  client: S3StorageClient;
}

/** Represents S3 Storage Client in the public GraphVault data model. */
export interface S3StorageClient {
  /** Reads object metadata and fails when the key is absent. */
  headObject(input: S3ObjectRequest): Promise<unknown>;
  /** Reads object bytes for a GraphVault storage key. */
  getObject(input: S3ObjectRequest): Promise<{ body?: S3Body }>;
  /** Writes object bytes and optional conditional-create metadata. */
  putObject(input: S3PutObjectRequest): Promise<unknown>;
  /** Removes one object key if it exists. */
  deleteObject(input: S3ObjectRequest): Promise<unknown>;
  /** Lists object keys and common prefixes below a prefix. */
  listObjects(input: S3ListObjectsRequest): Promise<S3ListObjectsResponse>;
}

/** Represents S3 Object Request in the public GraphVault data model. */
export interface S3ObjectRequest {
  bucket: string;
  key: string;
}

/** Represents S3 Put Object Request in the public GraphVault data model. */
export interface S3PutObjectRequest extends S3ObjectRequest {
  body: Buffer;
  ifNoneMatch?: "*";
  metadata?: Record<string, string>;
}

/** Represents S3 List Objects Request in the public GraphVault data model. */
export interface S3ListObjectsRequest {
  bucket: string;
  prefix: string;
  delimiter?: string;
  continuationToken?: string;
}

/** Represents S3 List Objects Response in the public GraphVault data model. */
export interface S3ListObjectsResponse {
  objects?: Array<{ key: string }>;
  commonPrefixes?: string[];
  nextContinuationToken?: string;
}

export type S3Body =
  | Buffer
  | Uint8Array
  | ArrayBuffer
  | string
  | AsyncIterable<Uint8Array>
  | { transformToByteArray(): Promise<Uint8Array> };

/** Storage target implementation backed by an S3-compatible object store. */
export class S3StorageTarget implements StorageTarget {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3StorageClient;

  /** Creates a S3 Storage Target backed by the supplied target configuration. */
  constructor(options: S3StorageTargetOptions) {
    this.bucket = options.bucket;
    this.prefix = normalizeS3Key(options.prefix ?? "");
    this.client = options.client;
  }

  /** Creates the directory namespace required by the storage layout when the backend needs one. */
  async ensureDirectory(path: string): Promise<void> {
    await this.client.putObject({
      bucket: this.bucket,
      key: this.key(`${path}/.dir`),
      body: Buffer.alloc(0),
      metadata: { directory: "true" },
    });
  }

  /** Returns whether a storage path currently exists and can be read by this target. */
  async exists(path: string): Promise<boolean> {
    const key = this.key(path);
    try {
      await this.client.headObject({ bucket: this.bucket, key });
      return true;
    } catch {
      const result = await this.client.listObjects({
        bucket: this.bucket,
        prefix: `${key}/`,
        delimiter: "/",
      });
      return Boolean(result.objects?.length || result.commonPrefixes?.length);
    }
  }

  /** Lists direct child names below a storage path. */
  async list(path: string): Promise<string[]> {
    const prefix = `${this.key(path)}/`;
    const names = new Set<string>();
    let continuationToken: string | undefined;
    do {
      const page = await this.client.listObjects({
        bucket: this.bucket,
        prefix,
        delimiter: "/",
        ...(continuationToken ? { continuationToken } : {}),
      });
      for (const object of page.objects ?? []) {
        const rest = object.key.slice(prefix.length);
        const [name] = rest.split("/");
        if (name && name !== ".dir") {
          names.add(name);
        }
      }
      for (const commonPrefix of page.commonPrefixes ?? []) {
        const rest = commonPrefix.slice(prefix.length).replace(/\/$/, "");
        const [name] = rest.split("/");
        if (name) {
          names.add(name);
        }
      }
      continuationToken = page.nextContinuationToken;
    } while (continuationToken);
    return Array.from(names).sort();
  }

  /** Reads a storage object as UTF-8 text. */
  async readText(path: string): Promise<string> {
    return this.readBuffer(path).then((buffer) => buffer.toString("utf8"));
  }

  /** Reads a storage object as bytes. */
  async readBuffer(path: string): Promise<Buffer> {
    const result = await this.client.getObject({ bucket: this.bucket, key: this.key(path) });
    if (!result.body) {
      throw new Error(`No body returned for S3 object ${path}.`);
    }
    return s3BodyToBuffer(result.body);
  }

  /** Writes UTF-8 text so readers see either the previous complete value or the new complete value. */
  async writeTextAtomic(path: string, value: string): Promise<void> {
    await this.writeBufferAtomic(path, Buffer.from(value));
  }

  /** Writes bytes so readers see either the previous complete value or the new complete value. */
  async writeBufferAtomic(path: string, value: Buffer): Promise<void> {
    await this.client.putObject({ bucket: this.bucket, key: this.key(path), body: value });
  }

  /** Appends UTF-8 text to an existing storage object, creating it when the backend supports that behavior. */
  async appendText(path: string, value: string): Promise<void> {
    let current: Buffer = Buffer.alloc(0);
    if (await this.exists(path)) {
      current = await this.readBuffer(path);
    }
    await this.writeBufferAtomic(path, Buffer.concat([current, Buffer.from(value)]));
  }

  /** Deletes a storage path, optionally removing all nested children for directory-like backends. */
  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    if (options.recursive) {
      const prefix = `${this.key(path)}/`;
      let continuationToken: string | undefined;
      do {
        const page = await this.client.listObjects({
          bucket: this.bucket,
          prefix,
          ...(continuationToken ? { continuationToken } : {}),
        });
        for (const object of page.objects ?? []) {
          await this.client.deleteObject({ bucket: this.bucket, key: object.key });
        }
        continuationToken = page.nextContinuationToken;
      } while (continuationToken);
    }
    await this.client.deleteObject({ bucket: this.bucket, key: this.key(path) });
    await this.client.deleteObject({ bucket: this.bucket, key: this.key(`${path}/.dir`) });
  }

  /** Acquires an exclusive storage lock and returns a fencing token that can be revalidated before publishing. */
  async acquireLock(path: string, timeoutMs: number, options: StorageLockOptions = {}): Promise<StorageTargetLock> {
    const key = this.key(path);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        await this.client.putObject({
          bucket: this.bucket,
          key,
          body: Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), fencingToken: 0 })),
          ifNoneMatch: "*",
        });
        const fencingToken = await this.nextFencingToken(key);
        await this.client.putObject({
          bucket: this.bucket,
          key,
          body: Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), fencingToken })),
        });
        return {
          fencingToken,
          assertValid: async () => {
            await this.assertLockToken(key, fencingToken);
          },
          release: async () => {
            await this.removeLockIfTokenMatches(key, fencingToken);
          },
        };
      } catch (error) {
        if (await this.removeStaleLock(key, options.staleLockTimeoutMs)) {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new StorageLockError(`Storage is already locked at s3://${this.bucket}/${key}.`, { cause: error });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  private key(path: string): string {
    const clean = normalizeS3Key(path);
    return this.prefix ? `${this.prefix}/${clean}` : clean;
  }

  private async removeStaleLock(key: string, staleLockTimeoutMs: number | undefined): Promise<boolean> {
    if (!isPositiveFinite(staleLockTimeoutMs)) {
      return false;
    }
    try {
      const result = await this.client.getObject({ bucket: this.bucket, key });
      if (!result.body) {
        return false;
      }
      if (isLockBodyStale((await s3BodyToBuffer(result.body)).toString("utf8"), staleLockTimeoutMs)) {
        await this.client.deleteObject({ bucket: this.bucket, key });
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private async nextFencingToken(lockKey: string): Promise<number> {
    const tokenKey = `${lockKey}.fencing-token`;
    let current = 0;
    try {
      const result = await this.client.getObject({ bucket: this.bucket, key: tokenKey });
      if (result.body) {
        current = Number.parseInt((await s3BodyToBuffer(result.body)).toString("utf8"), 10) || 0;
      }
    } catch {
      current = 0;
    }
    const next = current + 1;
    await this.client.putObject({ bucket: this.bucket, key: tokenKey, body: Buffer.from(String(next)) });
    return next;
  }

  private async assertLockToken(key: string, fencingToken: number): Promise<void> {
    const result = await this.client.getObject({ bucket: this.bucket, key });
    const body = result.body ? (await s3BodyToBuffer(result.body)).toString("utf8") : "";
    if (lockRecordFromText(body).fencingToken !== fencingToken) {
      throw new StorageLockError(`Storage lock token ${fencingToken} is no longer valid at s3://${this.bucket}/${key}.`);
    }
  }

  private async removeLockIfTokenMatches(key: string, fencingToken: number): Promise<void> {
    try {
      await this.assertLockToken(key, fencingToken);
      await this.client.deleteObject({ bucket: this.bucket, key });
    } catch {
      // A newer writer may already own the lock; releasing an old token must not remove it.
    }
  }
}

function normalizeS3Key(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function isLockBodyStale(body: string, staleLockTimeoutMs: number): boolean {
  const record = lockRecordFromText(body);
  if (!record.createdAt) {
    return false;
  }
  const createdAtMs = Date.parse(record.createdAt);
  return Number.isFinite(createdAtMs) && Date.now() - createdAtMs >= staleLockTimeoutMs;
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

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

async function s3BodyToBuffer(body: S3Body): Promise<Buffer> {
  if (Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body);
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if ("transformToByteArray" in body) {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
