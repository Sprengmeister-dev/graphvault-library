import { StorageManager } from "../storage/storage-manager.js";
import type { StorageManagerOptions } from "../core/types.js";

/** Root object shape used internally by PersistentCache. */
export interface PersistentCacheRoot<K, V> {
  entries: Map<K, V>;
}

/** Map-like cache persisted through GraphVault for small durable lookup tables. */
export class PersistentCache<K, V> {
  private constructor(private readonly storage: StorageManager<PersistentCacheRoot<K, V>>) {}

  /** Starts the backing StorageManager and returns a cache facade over its Map root. */
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

  /** Exposes the backing StorageManager for advanced operations such as backup, verification, and shutdown. */
  get manager(): StorageManager<PersistentCacheRoot<K, V>> {
    return this.storage;
  }

  /** Returns the number of entries in the persisted cache root. */
  get size(): number {
    return this.storage.root.entries.size;
  }

  /** Returns the cached value for a key, or undefined when the key is absent. */
  get(key: K): V | undefined {
    return this.storage.root.entries.get(key);
  }

  /** Returns whether the cache currently contains the provided key. */
  has(key: K): boolean {
    return this.storage.root.entries.has(key);
  }

  /** Sets a cache value and persists the updated cache root. */
  async set(key: K, value: V): Promise<this> {
    this.storage.root.entries.set(key, value);
    await this.storage.store(this.storage.root.entries);
    return this;
  }

  /** Removes a cache entry and persists the updated cache root when the key existed. */
  async delete(key: K): Promise<boolean> {
    const deleted = this.storage.root.entries.delete(key);
    if (deleted) {
      await this.storage.store(this.storage.root.entries);
    }
    return deleted;
  }

  /** Removes all cache entries and persists the empty cache root. */
  async clear(): Promise<void> {
    if (this.storage.root.entries.size === 0) {
      return;
    }
    this.storage.root.entries.clear();
    await this.storage.store(this.storage.root.entries);
  }

  /** Returns a snapshot iterator of cache key/value pairs currently loaded in memory. */
  entries(): IterableIterator<[K, V]> {
    return this.storage.root.entries.entries();
  }

  /** Returns a snapshot iterator of cache values currently loaded in memory. */
  values(): IterableIterator<V> {
    return this.storage.root.entries.values();
  }

  /** Returns a snapshot iterator of cache keys currently loaded in memory. */
  keys(): IterableIterator<K> {
    return this.storage.root.entries.keys();
  }

  /** Stops housekeeping and releases any startup lock held by this manager. */
  shutdown(): Promise<void> {
    return this.storage.shutdown();
  }
}
