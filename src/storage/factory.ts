import { StorageManager } from "./storage-manager.js";
import type { StorageManagerOptions } from "../core/types.js";

export async function startStorage<TRoot>(options: StorageManagerOptions<TRoot>): Promise<StorageManager<TRoot>> {
  return new StorageManager(options).start();
}
