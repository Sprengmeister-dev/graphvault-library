import type { StorageManager } from "./storage-manager.js";
import type { StoreMetadata, StoreMode } from "../core/types.js";

/** Provides the public Storer API. */
export class Storer {
  private readonly targets: unknown[] = [];
  private committed = false;

  /** Creates a Storer instance. */
  constructor(
    private readonly manager: StorageManager<any>,
    readonly mode: StoreMode,
  ) {}

  /** Runs Storer.store. */
  store(instance: unknown): this {
    this.assertOpen();
    this.targets.push(instance);
    return this;
  }

  /** Runs Storer.storeAll. */
  storeAll(instances: Iterable<unknown>): this {
    this.assertOpen();
    for (const instance of instances) {
      this.targets.push(instance);
    }
    return this;
  }

  /** Runs Storer.commit asynchronously. */
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
