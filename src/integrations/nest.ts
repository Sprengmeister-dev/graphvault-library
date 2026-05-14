import { StorageManager } from "../storage/storage-manager.js";
import type { GraphVaultTransactionOptions, StorageManagerOptions } from "../core/types.js";

export const GRAPHVAULT_MANAGER = Symbol("GRAPHVAULT_MANAGER");
export const GRAPHVAULT_OPTIONS = Symbol("GRAPHVAULT_OPTIONS");

export type NestInjectionToken = string | symbol | Function | NestType;

export interface NestType<T = unknown> extends Function {
  new (...args: any[]): T;
}

export type NestProvider = NestValueProvider | NestFactoryProvider | NestExistingProvider;

export interface NestValueProvider {
  provide: NestInjectionToken;
  useValue: unknown;
}

export interface NestFactoryProvider {
  provide: NestInjectionToken;
  useFactory: (...args: any[]) => unknown;
  inject?: NestInjectionToken[];
}

export interface NestExistingProvider {
  provide: NestInjectionToken;
  useExisting: NestInjectionToken;
}

export interface DynamicModuleLike {
  module: NestType;
  global?: boolean;
  providers: NestProvider[];
  exports: NestInjectionToken[];
}

export type GraphVaultModuleOptions<TRoot> = StorageManagerOptions<TRoot> & { global?: boolean };

export interface GraphVaultModuleAsyncOptions<TRoot> {
  global?: boolean;
  inject?: NestInjectionToken[];
  useFactory: (...args: any[]) => StorageManagerOptions<TRoot> | Promise<StorageManagerOptions<TRoot>>;
}

export interface GraphVaultTransactionalOptions<TRoot = unknown> extends GraphVaultTransactionOptions<TRoot> {
  managerProperty?: string | symbol;
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

export function GraphVaultTransactional<TRoot = unknown>(
  options: GraphVaultTransactionalOptions<TRoot> = {},
): MethodDecorator {
  return (_target, _propertyKey, descriptor) => {
    const original = descriptor.value;
    if (typeof original !== "function") {
      throw new TypeError("@GraphVaultTransactional can only decorate methods.");
    }
    (descriptor as PropertyDescriptor).value = async function graphVaultTransactionalWrapper(this: Record<PropertyKey, unknown>, ...args: unknown[]) {
      const manager = resolveGraphVaultManager<TRoot>(this, options.managerProperty);
      const result = await manager.transaction(() => original.apply(this, args), options);
      return result.value;
    };
    return descriptor;
  };
}

function resolveGraphVaultManager<TRoot>(
  instance: Record<PropertyKey, unknown>,
  managerProperty: string | symbol | undefined,
): StorageManager<TRoot> {
  if (managerProperty) {
    const manager = instance[managerProperty];
    if (manager instanceof StorageManager) {
      return manager as StorageManager<TRoot>;
    }
    throw new TypeError(`@GraphVaultTransactional could not find a StorageManager at property ${String(managerProperty)}.`);
  }
  for (const property of ["graphVault", "storage", "storageManager", "manager"]) {
    const manager = instance[property];
    if (manager instanceof StorageManager) {
      return manager as StorageManager<TRoot>;
    }
  }
  throw new TypeError("@GraphVaultTransactional requires a StorageManager property or an explicit managerProperty option.");
}
