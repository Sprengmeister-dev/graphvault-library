# NestJS Integration

## NestJS

GraphVault is intentionally easy to wire into NestJS: import the module once, then inject `StorageManager<AppRoot>` directly in your services.

```ts
import { Injectable, Module } from "@nestjs/common";
import { GraphVaultModule, StorageManager } from "graphvault";

interface AppRoot {
  documents: unknown[];
}

@Module({
  imports: [
    GraphVaultModule.forRoot<AppRoot>({
      global: true,
      storageDirectory: "./data",
      rootFactory: () => ({ documents: [] }),
    }),
  ],
})
export class AppModule {}

@Injectable()
export class DocumentsService {
  constructor(private readonly storage: StorageManager<AppRoot>) {}

  async add(document: unknown): Promise<void> {
    await this.storage.update((root) => {
      root.documents.push(document);
    });
  }
}
```

### NestJS With ConfigService

Use `forRootAsync(...)` when the directory, target, or options come from configuration.

```ts
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { GraphVaultModule } from "graphvault";

@Module({
  imports: [
    ConfigModule.forRoot(),
    GraphVaultModule.forRootAsync<AppRoot>({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        storageDirectory: config.getOrThrow("GRAPHVAULT_DIR"),
        rootFactory: () => ({ documents: [] }),
        lockTimeoutMs: 10_000,
      }),
    }),
  ],
})
export class AppModule {}
```

### Multiple Stores In NestJS

For one store, direct `StorageManager<AppRoot>` injection is the cleanest option. If you need multiple stores in the same Nest app, inject by token from custom providers or wrap each store in a domain-specific service. The built-in token is exported as `GRAPHVAULT_MANAGER`:

```ts
import { Inject, Injectable } from "@nestjs/common";
import { GRAPHVAULT_MANAGER, StorageManager } from "graphvault";

@Injectable()
export class GraphVaultRootService {
  constructor(
    @Inject(GRAPHVAULT_MANAGER)
    readonly storage: StorageManager<AppRoot>,
  ) {}
}
```

### NestJS Shutdown

`StorageManager` exposes a Nest-compatible `onApplicationShutdown()` hook. Nest will close the store when the application shuts down through the Nest lifecycle. For OS signal handling, enable shutdown hooks in your bootstrap:

```ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(3000);
```

You can still call `await storage.shutdown()` directly in scripts, tests, and workers.
