import { StorageManager } from "../storage/storage-manager.js";
import type { StorageManagerOptions } from "../core/types.js";

/** Describes the public PersistentCacheRoot contract. */
export interface PersistentCacheRoot<K, V> {
  entries: Map<K, V>;
}

/** Provides the public PersistentCache API. */
export class PersistentCache<K, V> {
  private constructor(private readonly storage: StorageManager<PersistentCacheRoot<K, V>>) {}

  static async start<K, V>(
    options: Omit<StorageManagerOptions<PersistentCacheRoot<K, V>>, "rootFactory"> & {
      rootFactory?: () => PersistentCacheRoot<K, V>;
    },
  ): Promise<PersistentCache<K, V>> {
    const storage = await new StorageManager<PersistentCacheRoot<K, V>>({
      ...options,
      rootFactory: options.rootFactory ?? (() => ({ entries: new Map<K, V>() })),
    }).start();
    return new PersistentCache(storage);
  }

  /** Returns the current manager value. */
  get manager(): StorageManager<PersistentCacheRoot<K, V>> {
    return this.storage;
  }

  /** Returns the current size value. */
  get size(): number {
    return this.storage.root.entries.size;
  }

  /** Runs PersistentCache.get. */
  get(key: K): V | undefined {
    return this.storage.root.entries.get(key);
  }

  /** Runs PersistentCache.has. */
  has(key: K): boolean {
    return this.storage.root.entries.has(key);
  }

  /** Runs PersistentCache.set asynchronously. */
  async set(key: K, value: V): Promise<this> {
    this.storage.root.entries.set(key, value);
    await this.storage.store(this.storage.root.entries);
    return this;
  }

  /** Runs PersistentCache.delete asynchronously. */
  async delete(key: K): Promise<boolean> {
    const deleted = this.storage.root.entries.delete(key);
    if (deleted) {
      await this.storage.store(this.storage.root.entries);
    }
    return deleted;
  }

  /** Runs PersistentCache.clear asynchronously. */
  async clear(): Promise<void> {
    if (this.storage.root.entries.size === 0) {
      return;
    }
    this.storage.root.entries.clear();
    await this.storage.store(this.storage.root.entries);
  }

  /** Runs PersistentCache.entries. */
  entries(): IterableIterator<[K, V]> {
    return this.storage.root.entries.entries();
  }

  /** Runs PersistentCache.values. */
  values(): IterableIterator<V> {
    return this.storage.root.entries.values();
  }

  /** Runs PersistentCache.keys. */
  keys(): IterableIterator<K> {
    return this.storage.root.entries.keys();
  }

  /** Runs PersistentCache.shutdown. */
  shutdown(): Promise<void> {
    return this.storage.shutdown();
  }
}
