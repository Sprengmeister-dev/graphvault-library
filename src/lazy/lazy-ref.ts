export type LazyLoader<T> = (key: string) => Promise<T>;
export type LazySaver<T> = (key: string, value: T) => Promise<void>;

export class LazyRef<T> {
  readonly key: string;
  private value: T | undefined;
  private loaded = false;
  private loader: LazyLoader<T> | undefined;
  private saver: LazySaver<T> | undefined;

  constructor(key: string, initialValue?: T) {
    this.key = key;
    if (arguments.length > 1) {
      this.value = initialValue;
      this.loaded = true;
    }
  }

  static unloaded<T>(key: string): LazyRef<T> {
    return new LazyRef<T>(key);
  }

  bind(loader: LazyLoader<T>, saver: LazySaver<T>): void {
    this.loader = loader;
    this.saver = saver;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  clear(): void {
    this.value = undefined;
    this.loaded = false;
  }

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

  set(value: T): void {
    this.value = value;
    this.loaded = true;
  }

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

export function lazy<T>(key: string, initialValue?: T): LazyRef<T> {
  return arguments.length > 1 ? new LazyRef<T>(key, initialValue) : LazyRef.unloaded<T>(key);
}
