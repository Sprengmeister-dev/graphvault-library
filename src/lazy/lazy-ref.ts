export type LazyLoader<T> = (key: string) => Promise<T>;
export type LazySaver<T> = (key: string, value: T) => Promise<void>;

/** Provides the public LazyRef API. */
export class LazyRef<T> {
  readonly key: string;
  private value: T | undefined;
  private loaded = false;
  private loader: LazyLoader<T> | undefined;
  private saver: LazySaver<T> | undefined;

  /** Creates a LazyRef instance. */
  constructor(key: string, initialValue?: T) {
    this.key = key;
    if (arguments.length > 1) {
      this.value = initialValue;
      this.loaded = true;
    }
  }

  /** Creates or configures LazyRef through unloaded. */
  static unloaded<T>(key: string): LazyRef<T> {
    return new LazyRef<T>(key);
  }

  /** Runs LazyRef.bind. */
  bind(loader: LazyLoader<T>, saver: LazySaver<T>): void {
    this.loader = loader;
    this.saver = saver;
  }

  /** Runs LazyRef.isLoaded. */
  isLoaded(): boolean {
    return this.loaded;
  }

  /** Runs LazyRef.clear. */
  clear(): void {
    this.value = undefined;
    this.loaded = false;
  }

  /** Runs LazyRef.get asynchronously. */
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

  /** Runs LazyRef.set. */
  set(value: T): void {
    this.value = value;
    this.loaded = true;
  }

  /** Runs LazyRef.store asynchronously. */
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

/** Runs the public lazy helper. */
export function lazy<T>(key: string, initialValue?: T): LazyRef<T> {
  return arguments.length > 1 ? new LazyRef<T>(key, initialValue) : LazyRef.unloaded<T>(key);
}
