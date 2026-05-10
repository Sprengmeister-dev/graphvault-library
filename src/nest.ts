import { StorageManager } from "./storage-manager.js";
import type { StorageManagerOptions } from "./types.js";

export const GRAPHVAULT_MANAGER = Symbol("GRAPHVAULT_MANAGER");
export const GRAPHVAULT_OPTIONS = Symbol("GRAPHVAULT_OPTIONS");

export interface NestProvider {
  provide: unknown;
  useValue?: unknown;
  useFactory?: (...args: never[]) => unknown;
  inject?: unknown[];
}

export interface DynamicModuleLike {
  module: unknown;
  global?: boolean;
  providers: NestProvider[];
  exports: unknown[];
}

export class GraphVaultModule {
  static forRoot<TRoot>(options: StorageManagerOptions<TRoot> & { global?: boolean }): DynamicModuleLike {
    const module: DynamicModuleLike = {
      module: GraphVaultModule,
      providers: [
        { provide: GRAPHVAULT_OPTIONS, useValue: options },
        {
          provide: GRAPHVAULT_MANAGER,
          useFactory: async () => new StorageManager(options).start(),
        },
      ],
      exports: [GRAPHVAULT_MANAGER],
    };
    if (typeof options.global === "boolean") {
      module.global = options.global;
    }
    return module;
  }
}
