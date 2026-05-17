import type { StorageManager } from "./storage-manager.js";
import type { StoreMetadata, StoreMode } from "../core/types.js";

/** Unit-of-work helper for batching explicit object-store requests before one commit. */
export class Storer {
  private readonly targets: unknown[] = [];
  private committed = false;

  /** Creates a Storer with the supplied configuration. */
  constructor(
    private readonly manager: StorageManager<any>,
    readonly mode: StoreMode,
  ) {}

  /** Queues one object for this storer; the object is persisted when commit() is called. */
  store(instance: unknown): this {
    this.assertOpen();
    this.targets.push(instance);
    return this;
  }

  /** Queues multiple objects to be persisted together when commit() is called. */
  storeAll(instances: Iterable<unknown>): this {
    this.assertOpen();
    for (const instance of instances) {
      this.targets.push(instance);
    }
    return this;
  }

  /** Persists all objects queued in this storer as one GraphVault commit. */
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
