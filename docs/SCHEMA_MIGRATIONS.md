# Schema Migrations

GraphVault supports storage-wide schema migrations for changes that affect the persisted object graph as a whole. This complements type-level class migrations: type registrations restore and migrate individual class payloads during deserialization, while schema migrations rewrite the stored root graph and commit the result as a normal GraphVault transaction.

## Model

A migration with `version: 1` upgrades the store from schema version `0` to `1`. Its `down` function downgrades the store from `1` to `0`.

```ts
import { EmbeddedStorage, type StorageSchemaMigration } from "@sprengmeister/graphvault";

interface AppRoot {
  people: Array<Record<string, unknown>>;
}

const migrations: Array<StorageSchemaMigration<AppRoot>> = [
  {
    version: 1,
    name: "split-person-name",
    up: ({ root }) => {
      for (const person of root.people) {
        const [firstName, ...lastName] = String(person.fullName).split(" ");
        person.firstName = firstName;
        person.lastName = lastName.join(" ");
        delete person.fullName;
      }
    },
    down: ({ root }) => {
      for (const person of root.people) {
        person.fullName = `${person.firstName ?? ""} ${person.lastName ?? ""}`.trim();
        delete person.firstName;
        delete person.lastName;
      }
    },
  },
];
```

## Running Migrations

Open the store with a target `schemaVersion` and the ordered migration set, then migrate explicitly:

```ts
const storage = await EmbeddedStorage.start<AppRoot>({
  storageDirectory: "./data",
  rootFactory: () => ({ people: [] }),
  schemaVersion: 1,
  schemaMigrations: migrations,
});

const status = storage.migrationStatus();
console.log(status.currentVersion, status.targetVersion, status.pending);

await storage.migrateTo();
```

`migrateTo()` without arguments migrates to `schemaVersion`. Passing a number migrates to that exact version, including downward:

```ts
await storage.migrateTo(0);
```

You can opt into startup migration:

```ts
const storage = await EmbeddedStorage.start<AppRoot>({
  storageDirectory: "./data",
  rootFactory: () => ({ people: [] }),
  schemaVersion: 3,
  schemaMigrations: migrations,
  migrateOnStart: true,
});
```

For critical systems, prefer explicit migration jobs before rolling out application pods. `migrateOnStart` is useful for development, single-process tools, or controlled deployments where exactly one writer starts first.

## Guarantees

Each migration step is committed as its own pessimistic GraphVault transaction:

- the shared writer lock is held while the step runs and commits
- the normal WAL prepare/commit path is used
- object records remain transaction-versioned
- the manifest stores the resulting `schemaVersion`
- the transaction record stores `schemaVersion`
- transaction metadata contains `schemaMigration` with direction, source version, target version, and migration name
- the transaction hash chain includes the migration metadata

If a migration callback throws, GraphVault rolls back the in-memory root and the schema version for that step, and no partial commit is published.

## New Stores

For a new empty store, `rootFactory` should create the current target shape. GraphVault initializes the store's in-memory schema version to `schemaVersion` or, if omitted, the highest migration version. Existing stores without a schema version are treated as version `0`.

## Operational Pattern

Recommended production rollout:

1. Stop regular writers or route write traffic away.
2. Start one migration runner with the new code and the full migration list.
3. Run `await storage.health()` before the migration.
4. Check `storage.migrationStatus()`.
5. Run `await storage.migrateTo(targetVersion)`.
6. Run `await storage.verify()` or `await storage.health()`.
7. Start the application pods with the same `schemaVersion`.

Keep every historical migration in source control for as long as you need to open or downgrade older stores.
