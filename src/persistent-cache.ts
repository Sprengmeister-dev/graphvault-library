import { StorageManager } from "./storage-manager.js";
import type { StorageManagerOptions } from "./types.js";

export interface PersistentCacheRoot<K, V> {
  entries: Map<K, V>;
}

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

  get manager(): StorageManager<PersistentCacheRoot<K, V>> {
    return this.storage;
  }

  get size(): number {
    return this.storage.root.entries.size;
  }

  get(key: K): V | undefined {
    return this.storage.root.entries.get(key);
  }

  has(key: K): boolean {
    return this.storage.root.entries.has(key);
  }

  async set(key: K, value: V): Promise<this> {
    this.storage.root.entries.set(key, value);
    await this.storage.store(this.storage.root.entries);
    return this;
  }

  async delete(key: K): Promise<boolean> {
    const deleted = this.storage.root.entries.delete(key);
    if (deleted) {
      await this.storage.store(this.storage.root.entries);
    }
    return deleted;
  }

  async clear(): Promise<void> {
    if (this.storage.root.entries.size === 0) {
      return;
    }
    this.storage.root.entries.clear();
    await this.storage.store(this.storage.root.entries);
  }

  entries(): IterableIterator<[K, V]> {
    return this.storage.root.entries.entries();
  }

  values(): IterableIterator<V> {
    return this.storage.root.entries.values();
  }

  keys(): IterableIterator<K> {
    return this.storage.root.entries.keys();
  }

  shutdown(): Promise<void> {
    return this.storage.shutdown();
  }
}
