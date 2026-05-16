import { StorageManager } from "./storage-manager.js";
import type { StorageManagerOptions } from "../core/types.js";

/** Describes the public EmbeddedStorageStartOptions contract. */
export interface EmbeddedStorageStartOptions<TRoot> extends Omit<StorageManagerOptions<TRoot>, "rootFactory"> {
  root?: TRoot;
  rootFactory?: () => TRoot;
}

/** Provides the public EmbeddedStorage API. */
export class EmbeddedStorage {
  /** Creates or configures EmbeddedStorage through start. */
  static start<TRoot>(root: TRoot, storageDirectory?: string): Promise<StorageManager<TRoot>>;
  /** Creates or configures EmbeddedStorage through start. */
  static start<TRoot>(options: EmbeddedStorageStartOptions<TRoot>): Promise<StorageManager<TRoot>>;
  /** Creates or configures EmbeddedStorage through start. */
  static start<TRoot extends object>(): Promise<StorageManager<Record<string, never>>>;
  static async start<TRoot>(
    rootOrOptions?: TRoot | EmbeddedStorageStartOptions<TRoot>,
    storageDirectory = "storage",
  ): Promise<StorageManager<TRoot> | StorageManager<Record<string, never>>> {
    if (!rootOrOptions) {
      return new StorageManager<Record<string, never>>({
        storageDirectory,
        rootFactory: () => ({}),
      }).start();
    }

    if (isStartOptions(rootOrOptions)) {
      const rootFactory = rootOrOptions.rootFactory ?? (() => rootOrOptions.root as TRoot);
      return new StorageManager<TRoot>({
        ...rootOrOptions,
        rootFactory,
        ...(typeof rootOrOptions.root !== "undefined" ? { customRoot: rootOrOptions.root } : {}),
      }).start();
    }

    return new StorageManager<TRoot>({
      storageDirectory,
      rootFactory: () => rootOrOptions,
      customRoot: rootOrOptions,
    }).start();
  }
}

function isStartOptions<TRoot>(value: TRoot | EmbeddedStorageStartOptions<TRoot>): value is EmbeddedStorageStartOptions<TRoot> {
  return typeof value === "object" && value !== null && ("storageDirectory" in value || "rootFactory" in value || "root" in value);
}
