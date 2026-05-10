import { StorageManager } from "./storage-manager.js";
import type { StorageManagerOptions } from "./types.js";

export const GRAPHVAULT_MANAGER = Symbol("GRAPHVAULT_MANAGER");
export const GRAPHVAULT_OPTIONS = Symbol("GRAPHVAULT_OPTIONS");

export interface NestProvider {
  provide: unknown;
  useValue?: unknown;
  useFactory?: (...args: any[]) => unknown;
  useExisting?: unknown;
  inject?: unknown[];
}

export interface DynamicModuleLike {
  module: unknown;
  global?: boolean;
  providers: NestProvider[];
  exports: unknown[];
}

export type GraphVaultModuleOptions<TRoot> = StorageManagerOptions<TRoot> & { global?: boolean };

export interface GraphVaultModuleAsyncOptions<TRoot> {
  global?: boolean;
  inject?: unknown[];
  useFactory: (...args: any[]) => StorageManagerOptions<TRoot> | Promise<StorageManagerOptions<TRoot>>;
}

export class GraphVaultModule {
  static forRoot<TRoot>(options: GraphVaultModuleOptions<TRoot>): DynamicModuleLike {
    return this.moduleFromOptionsProvider(options.global, {
      provide: GRAPHVAULT_OPTIONS,
      useValue: options,
    });
  }

  static forRootAsync<TRoot>(options: GraphVaultModuleAsyncOptions<TRoot>): DynamicModuleLike {
    return this.moduleFromOptionsProvider(options.global, {
      provide: GRAPHVAULT_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    });
  }

  private static moduleFromOptionsProvider(global: boolean | undefined, optionsProvider: NestProvider): DynamicModuleLike {
    return {
      module: GraphVaultModule,
      ...(typeof global === "boolean" ? { global } : {}),
      providers: [
        optionsProvider,
        {
          provide: GRAPHVAULT_MANAGER,
          useFactory: async (options: StorageManagerOptions<unknown>) => new StorageManager(options).start(),
          inject: [GRAPHVAULT_OPTIONS],
        },
        {
          provide: StorageManager,
          useExisting: GRAPHVAULT_MANAGER,
        },
      ],
      exports: [GRAPHVAULT_MANAGER, StorageManager],
    };
  }
}
