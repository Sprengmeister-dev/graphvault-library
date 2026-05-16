# NestJS Integration

## NestJS

GraphVault is intentionally easy to wire into NestJS: import the module once, then inject `StorageManager<AppRoot>` directly in your services.

```ts
import { Injectable, Module } from "@nestjs/common";
import { GraphVaultModule, StorageManager } from "@sprengmeister/graphvault";

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
import { GraphVaultModule } from "@sprengmeister/graphvault";

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
        staleLockTimeoutMs: 120_000,
      }),
    }),
  ],
})
export class AppModule {}
```

For a shared PostgreSQL-backed store, create the SQL client adapter once and pass `dialect: "postgres"`:

```ts
import pg from "pg";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { GraphVaultModule, SqlStorageTarget } from "@sprengmeister/graphvault";

@Module({
  imports: [
    ConfigModule.forRoot(),
    GraphVaultModule.forRootAsync<AppRoot>({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const pool = new pg.Pool({
          connectionString: config.getOrThrow("GRAPHVAULT_POSTGRES_URL"),
        });
        return {
          storageDirectory: config.get("GRAPHVAULT_STORE", "main"),
          storageTarget: new SqlStorageTarget({
            client: createPgGraphVaultClient(pool),
            dialect: "postgres",
          }),
          rootFactory: () => ({ documents: [] }),
          lockStrategy: "pessimistic",
          transactionLog: "full",
          staleLockTimeoutMs: 120_000,
        };
      },
    }),
  ],
})
export class AppModule {}
```

See [storage configuration](./STORAGE.md#sql-storage) for the complete `pg` adapter, transaction handling, and integration-test setup.

### Multiple Stores In NestJS

For one store, direct `StorageManager<AppRoot>` injection is the cleanest option. If you need multiple stores in the same Nest app, inject by token from custom providers or wrap each store in a domain-specific service. The built-in token is exported as `GRAPHVAULT_MANAGER`:

```ts
import { Inject, Injectable } from "@nestjs/common";
import { GRAPHVAULT_MANAGER, StorageManager } from "@sprengmeister/graphvault";

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

### Transactional Service Methods

Use `@GraphVaultTransactional()` for service methods that must commit several related mutations as one unit. The decorator wraps the method in `storage.transaction(...)`, so failures roll back the whole method and multiple pods/users get the same optimistic or pessimistic write protection as direct transaction calls.

```ts
import { Injectable } from "@nestjs/common";
import { GraphVaultTransactional, StorageManager } from "@sprengmeister/graphvault";

@Injectable()
export class DocumentService {
  constructor(readonly storage: StorageManager<AppRoot>) {}

  @GraphVaultTransactional({ mode: "pessimistic", managerProperty: "storage" })
  async approve(id: string): Promise<string> {
    const document = this.storage.root.documents.find((item) => item.id === id);
    document.status = "approved";
    return document.status;
  }
}
```

### REST Subtree Endpoints

For APIs that expose a graph fragment, keep the response bounded with `loadSubtree(...)` instead of serializing the full root.

```ts
import { Controller, Get, Param, Query } from "@nestjs/common";
import { StorageManager } from "@sprengmeister/graphvault";

@Controller("graph")
export class GraphController {
  constructor(private readonly storage: StorageManager<AppRoot>) {}

  @Get(":objectId")
  async getSubtree(@Param("objectId") objectId: string, @Query("depth") depth = "2") {
    return this.storage.loadSubtree(objectId, {
      depth: Number.parseInt(depth, 10),
    });
  }
}
```

The response includes the bounded `envelope`, loaded `objectIds`, and `truncatedReferences` so clients can request deeper slices deliberately.

### Health Endpoints

Expose a lightweight readiness endpoint from `health({ verify: false })`, and keep the full verification pass for startup gates, scheduled checks, or operator-only endpoints.

```ts
import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { StorageManager } from "@sprengmeister/graphvault";

@Controller("health")
export class HealthController {
  constructor(private readonly storage: StorageManager<AppRoot>) {}

  @Get("graphvault")
  async graphvault() {
    const health = await this.storage.health({ verify: false });
    if (!health.ok) {
      throw new ServiceUnavailableException(health);
    }
    return health;
  }
}
```

The report includes operational counters, the production safety profile, and optionally the full verification result when you call `health()` without `{ verify: false }`.

### Migration Jobs

For production NestJS deployments, run schema migrations as a separate job before rolling the application pods:

```ts
const storage = await EmbeddedStorage.start<AppRoot>({
  storageDirectory: process.env.GRAPHVAULT_DIR,
  rootFactory: () => ({ documents: [] }),
  schemaVersion: 3,
  schemaMigrations,
});

await storage.health();
await storage.migrateTo();
await storage.health();
await storage.shutdown();
```

This keeps startup predictable and makes the migration result visible in logs, metrics, and the GraphVault transaction journal. Use `migrateOnStart` only for simpler deployments where one controlled writer starts first.
