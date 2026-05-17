import { StorageManager } from "../storage/storage-manager.js";
import type { GraphVaultTransactionOptions, StorageManagerOptions } from "../core/types.js";

export const GRAPHVAULT_MANAGER = Symbol("GRAPHVAULT_MANAGER");
export const GRAPHVAULT_OPTIONS = Symbol("GRAPHVAULT_OPTIONS");

export type NestInjectionToken = string | symbol | Function | NestType;

/** Constructor shape used by NestJS provider definitions. */
export interface NestType<T = unknown> extends Function {
  /** Constructs a Nest provider class instance. */
  new (...args: any[]): T;
}

export type NestProvider = NestValueProvider | NestFactoryProvider | NestExistingProvider;

/** Represents Nest Value Provider in the public GraphVault data model. */
export interface NestValueProvider {
  provide: NestInjectionToken;
  useValue: unknown;
}

/** Represents Nest Factory Provider in the public GraphVault data model. */
export interface NestFactoryProvider {
  provide: NestInjectionToken;
  useFactory: (...args: any[]) => unknown;
  inject?: NestInjectionToken[];
}

/** Represents Nest Existing Provider in the public GraphVault data model. */
export interface NestExistingProvider {
  provide: NestInjectionToken;
  useExisting: NestInjectionToken;
}

/** Small subset of NestJS DynamicModule used so GraphVault can integrate without a hard Nest dependency. */
export interface DynamicModuleLike {
  module: NestType;
  global?: boolean;
  providers: NestProvider[];
  exports: NestInjectionToken[];
}

export type GraphVaultModuleOptions<TRoot> = StorageManagerOptions<TRoot> & { global?: boolean };

/** NestJS async provider options for creating StorageManagerOptions at module-registration time. */
export interface GraphVaultModuleAsyncOptions<TRoot> {
  global?: boolean;
  inject?: NestInjectionToken[];
  useFactory: (...args: any[]) => StorageManagerOptions<TRoot> | Promise<StorageManagerOptions<TRoot>>;
}

/** Decorator options that control which StorageManager property is used for a transactional method. */
export interface GraphVaultTransactionalOptions<TRoot = unknown> extends GraphVaultTransactionOptions<TRoot> {
  managerProperty?: string | symbol;
}

/** Minimal NestJS dynamic module factory for providing a StorageManager through dependency injection. */
export class GraphVaultModule {
  /** Registers a StorageManager provider from concrete GraphVault options in a NestJS module. */
  static forRoot<TRoot>(options: GraphVaultModuleOptions<TRoot>): DynamicModuleLike {
    return this.moduleFromOptionsProvider(options.global, {
      provide: GRAPHVAULT_OPTIONS,
      useValue: options,
    });
  }

  /** Registers a StorageManager provider whose GraphVault options are produced asynchronously by NestJS. */
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

/** Method decorator that wraps a service method in a GraphVault transaction using a manager property on the instance. */
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
