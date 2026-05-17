export type LazyLoader<T> = (key: string) => Promise<T>;
export type LazySaver<T> = (key: string, value: T) => Promise<void>;

/** Reference wrapper for values that should be loaded from storage only when accessed. */
export class LazyRef<T> {
  readonly key: string;
  private value: T | undefined;
  private loaded = false;
  private loader: LazyLoader<T> | undefined;
  private saver: LazySaver<T> | undefined;

  /** Creates a Lazy Ref with the supplied configuration. */
  constructor(key: string, initialValue?: T) {
    this.key = key;
    if (arguments.length > 1) {
      this.value = initialValue;
      this.loaded = true;
    }
  }

  /** Creates a LazyRef placeholder that will load its value on first access. */
  static unloaded<T>(key: string): LazyRef<T> {
    return new LazyRef<T>(key);
  }

  /** Connects this lazy reference to load and store callbacks supplied by a StorageManager. */
  bind(loader: LazyLoader<T>, saver: LazySaver<T>): void {
    this.loader = loader;
    this.saver = saver;
  }

  /** Returns whether the lazy value is currently materialized in memory. */
  isLoaded(): boolean {
    return this.loaded;
  }

  /** Removes all cache entries and persists the empty cache root. */
  clear(): void {
    this.value = undefined;
    this.loaded = false;
  }

  /** Returns the cached value for a key, or undefined when the key is absent. */
  async get(): Promise<T> {
    if (!this.loaded) {
      if (!this.loader) {
        throw new Error(`Lazy reference "${this.key}" has no loader bound.`);
      }
      this.value = await this.loader(this.key);
      this.loaded = true;
    }
    return this.value as T;
  }

  /** Sets a cache value and persists the updated cache root. */
  set(value: T): void {
    this.value = value;
    this.loaded = true;
  }

  /** Stores the currently loaded value through the bound storage callback, if a callback is configured. */
  async store(): Promise<void> {
    if (!this.loaded) {
      return;
    }
    if (!this.saver) {
      throw new Error(`Lazy reference "${this.key}" has no saver bound.`);
    }
    await this.saver(this.key, this.value as T);
  }
}

/** Creates a LazyRef bound to an initial value for explicit lazy persistence. */
export function lazy<T>(key: string, initialValue?: T): LazyRef<T> {
  return arguments.length > 1 ? new LazyRef<T>(key, initialValue) : LazyRef.unloaded<T>(key);
}
