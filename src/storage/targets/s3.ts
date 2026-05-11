import { StorageLockError } from "../../core/errors.js";
import type { StorageLockOptions, StorageTarget, StorageTargetLock } from "../../core/types.js";

export interface S3StorageTargetOptions {
  bucket: string;
  prefix?: string;
  client: S3StorageClient;
}

export interface S3StorageClient {
  headObject(input: S3ObjectRequest): Promise<unknown>;
  getObject(input: S3ObjectRequest): Promise<{ body?: S3Body }>;
  putObject(input: S3PutObjectRequest): Promise<unknown>;
  deleteObject(input: S3ObjectRequest): Promise<unknown>;
  listObjects(input: S3ListObjectsRequest): Promise<S3ListObjectsResponse>;
}

export interface S3ObjectRequest {
  bucket: string;
  key: string;
}

export interface S3PutObjectRequest extends S3ObjectRequest {
  body: Buffer;
  ifNoneMatch?: "*";
  metadata?: Record<string, string>;
}

export interface S3ListObjectsRequest {
  bucket: string;
  prefix: string;
  delimiter?: string;
  continuationToken?: string;
}

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

export class S3StorageTarget implements StorageTarget {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3StorageClient;

  constructor(options: S3StorageTargetOptions) {
    this.bucket = options.bucket;
    this.prefix = normalizeS3Key(options.prefix ?? "");
    this.client = options.client;
  }

  async ensureDirectory(path: string): Promise<void> {
    await this.client.putObject({
      bucket: this.bucket,
      key: this.key(`${path}/.dir`),
      body: Buffer.alloc(0),
      metadata: { directory: "true" },
    });
  }

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

  async readText(path: string): Promise<string> {
    return this.readBuffer(path).then((buffer) => buffer.toString("utf8"));
  }

  async readBuffer(path: string): Promise<Buffer> {
    const result = await this.client.getObject({ bucket: this.bucket, key: this.key(path) });
    if (!result.body) {
      throw new Error(`No body returned for S3 object ${path}.`);
    }
    return s3BodyToBuffer(result.body);
  }

  async writeTextAtomic(path: string, value: string): Promise<void> {
    await this.writeBufferAtomic(path, Buffer.from(value));
  }

  async writeBufferAtomic(path: string, value: Buffer): Promise<void> {
    await this.client.putObject({ bucket: this.bucket, key: this.key(path), body: value });
  }

  async appendText(path: string, value: string): Promise<void> {
    let current: Buffer = Buffer.alloc(0);
    if (await this.exists(path)) {
      current = await this.readBuffer(path);
    }
    await this.writeBufferAtomic(path, Buffer.concat([current, Buffer.from(value)]));
  }

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

  async acquireLock(path: string, timeoutMs: number, options: StorageLockOptions = {}): Promise<StorageTargetLock> {
    const key = this.key(path);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        await this.client.putObject({
          bucket: this.bucket,
          key,
          body: Buffer.from(JSON.stringify({ createdAt: new Date().toISOString() })),
          ifNoneMatch: "*",
        });
        return {
          release: async () => {
            await this.client.deleteObject({ bucket: this.bucket, key });
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
}

function normalizeS3Key(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function isLockBodyStale(body: string, staleLockTimeoutMs: number): boolean {
  try {
    const parsed = JSON.parse(body) as { createdAt?: unknown };
    if (typeof parsed.createdAt !== "string") {
      return false;
    }
    const createdAtMs = Date.parse(parsed.createdAt);
    return Number.isFinite(createdAtMs) && Date.now() - createdAtMs >= staleLockTimeoutMs;
  } catch {
    return false;
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
