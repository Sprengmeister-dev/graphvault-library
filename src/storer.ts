import type { StorageManager } from "./storage-manager.js";
import type { StoreMetadata, StoreMode } from "./types.js";

export class Storer {
  private readonly targets: unknown[] = [];
  private committed = false;

  constructor(
    private readonly manager: StorageManager,
    readonly mode: StoreMode,
  ) {}

  store(instance: unknown): this {
    this.assertOpen();
    this.targets.push(instance);
    return this;
  }

  storeAll(instances: Iterable<unknown>): this {
    this.assertOpen();
    for (const instance of instances) {
      this.targets.push(instance);
    }
    return this;
  }

  async commit(): Promise<StoreMetadata> {
    this.assertOpen();
    this.committed = true;
    return this.manager.commitStorer(this.mode, this.targets);
  }

  private assertOpen(): void {
    if (this.committed) {
      throw new Error("Storer has already been committed.");
    }
  }
}
