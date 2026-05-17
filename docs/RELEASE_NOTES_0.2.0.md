# GraphVault TS 0.2.0 Release Notes

GraphVault TS 0.2.0 is the production-hardening release. It focuses on multi-pod write safety, crash recovery, auditability, operational visibility, bounded graph export, and better performance gates.

## Why Upgrade

Use 0.2.0 if GraphVault is more than a local prototype: shared application pods, admin mutations, financial or audit-sensitive records, backup workflows, or REST endpoints that expose graph slices all benefit from this release.

## What Is New

- Explicit `transaction(...)` API with rollback semantics.
- Optimistic and pessimistic locking modes for shared stores.
- Fencing tokens on writer locks to reject stale recovered writers.
- WAL prepare/commit records with recovery for committed-but-not-published transactions.
- Transaction-versioned object records so old manifests cannot observe partially written newer records.
- Tamper-evident SHA-256 transaction hash chain.
- Transaction metadata for actor, reason, source, trace ID, tags, and audit attributes.
- `commitValidators` for application consistency checks before WAL prepare.
- `operations()` for lightweight production health and recovery visibility.
- Consistent application backups by default, including writer-lock and WAL awareness.
- Depth-limited `loadSubtree(...)` for bounded REST/API graph exposure.
- Optional `EncryptedStorageTarget` AES-256-GCM wrapper for payload encryption at rest.
- Storage-target conformance tests for file semantics, locks, stale-lock recovery, and fencing tokens.
- Benchmark JSON output and `benchmark:check` regression gate.

## Recommended Production Defaults

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data/graphvault",
  rootFactory: () => ({ documents: [] }),
  lockStrategy: "pessimistic",
  transactionLog: "full",
  recoverCommittedWal: true,
  readCommittedWal: true,
  writeDurability: "strict",
  staleLockTimeoutMs: 120_000,
});
```

For high-throughput local stores where operational debugging JSON is less important, use the default `writeProfile: "production"` and keep `transactionLog: "full"` unless the store is disposable.

## Bounded Graph Export

```ts
const subtree = await storage.loadSubtree("object-id", { depth: 2 });
```

`depth: 0` returns only the start object. Each higher depth includes one more level of referenced objects. `truncatedReferences` reports the outbound references intentionally left out at the boundary.

## Encryption At Rest

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  storageTarget: new EncryptedStorageTarget({
    target: new LocalFilesystemTarget(),
    key: process.env.GRAPHVAULT_STORAGE_KEY!,
  }),
  rootFactory: () => ({ documents: [] }),
});
```

Keep keys in your deployment secrets manager. GraphVault cannot recover encrypted payloads after key loss.

## Verification

Before publishing or deploying this release:

```bash
npm ci
npm test
npm run benchmark:check
npm run pack:dry-run
```

## Known Boundaries

GraphVault 0.2.0 substantially improves embedded durability and shared-writer behavior, but it is still not a replicated consensus database. If many independent processes outside one application boundary write concurrently, or if you need database-server roles, online replication, cross-region consensus, or SQL compatibility, use GraphVault behind a service boundary or choose a mature server database.
