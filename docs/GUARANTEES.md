# Guarantees And Boundaries

This page states what GraphVault is designed to guarantee, what must be provided by the configured storage target, and where a traditional database remains the better tool.

## Short Version

GraphVault is an embedded object-graph database for application-owned data. It gives one application a durable, queryable, auditable object graph with explicit commits, WAL recovery, persistent indexes, schema migrations, bounded subtree loading, and NestJS-friendly transactions.

GraphVault is not a clustered SQL server. It does not provide SQL wire compatibility, external roles, query federation, replicated consensus, automatic failover leadership, or a DBA ecosystem.

## ACID-Oriented Guarantees

With `transactionLog: "full"`, `recoverCommittedWal: true`, `readCommittedWal: true`, a verified storage target, and all writes going through `transaction(...)`, GraphVault provides:

- **Atomic graph commits**: a failed transaction rolls the in-memory root back and publishes no new manifest.
- **Crash recovery**: committed WAL entries can be completed after a crash before manifest publication.
- **Manifest isolation**: object records are transaction-versioned; an old manifest cannot accidentally observe newer partial object records.
- **Serialized writes**: pessimistic transactions hold the shared writer lock from read to commit; optimistic transactions retry when another writer wins.
- **Fencing tokens**: recovered locks get newer tokens, stale writers cannot publish commit metadata or release a newer lock.
- **Tamper-evident history**: transaction records form a SHA-256 hash chain checked by `verify()`.
- **Storage-wide migrations**: `up` and `down` migration steps commit through the same transaction path as application writes.

## What The Storage Target Must Guarantee

For a shared production store, the target must provide:

- atomic replacement for stored objects
- read-after-write consistency for commit metadata
- one visible writer lock across every pod that can write to the store
- token-aware lock release
- monotonically increasing fencing tokens after stale-lock recovery
- durable BLOB/object payload handling

The built-in local and memory targets are covered by the conformance suite. SQLite and PostgreSQL integration tests exercise the SQL target against real engines. Custom HTTP, S3-compatible, or SQL adapters should pass equivalent tests in production-like infrastructure before they hold critical data.

## Tested Storage Paths

The normal test suite covers local filesystem, memory, encrypted memory, HTTP-style behavior, S3-style behavior, SQLite via `sql.js`, and PostgreSQL when `GRAPHVAULT_POSTGRES_URL` is set. GitHub Actions runs the PostgreSQL integration test against a real Postgres service.

The PostgreSQL path verifies:

- schema creation with `BYTEA` object bodies
- `$1`-style parameter binding
- BLOB round trips
- recursive deletion and listing
- primary-key lock conflicts
- stale-lock recovery
- fencing-token invalidation
- transaction rollback after a failed SQL write
- full `EmbeddedStorage` write, GVQL update, shutdown, and reload

## Recommended Production Profile

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "graphvault/prod",
  storageTarget,
  rootFactory: () => ({ cases: [] }),
  lockStrategy: "pessimistic",
  lockTimeoutMs: 30_000,
  staleLockTimeoutMs: 120_000,
  transactionLog: "full",
  recoverCommittedWal: true,
  readCommittedWal: true,
  writeDurability: "strict",
  writeProfile: "standard",
  commitValidators: [
    ({ root }) => {
      if (!Array.isArray(root.cases)) {
        throw new Error("Root cases must stay an array.");
      }
    },
  ],
});
```

For mostly independent writers with rare conflicts, use `lockStrategy: "optimistic"` and bounded retry settings. For financial or audit-heavy state, prefer pessimistic transactions unless you have measured and accepted conflict behavior.

## When Not To Use GraphVault

Use PostgreSQL, SQLite, MongoDB, Neo4j, Redis, or another dedicated database when:

- multiple unrelated applications need independent write ownership
- SQL compatibility and ad-hoc reporting are primary requirements
- external user and role management belongs in the database layer
- built-in replication, consensus, or automatic failover is mandatory
- the data model is mostly flat records instead of a connected object graph
- operators need mature database-native tooling more than application-owned graph persistence

## What Verification Proves

`verify()` checks manifest consistency, object records, references, WAL pairs, transaction hashes, snapshot hashes, lazy payload reachability, and persistent index freshness.

It cannot prove that your application invariants are correct, that every custom storage service is deployed correctly, or that infrastructure replication is safe. Use `commitValidators`, domain tests, backup drills, and storage-target integration tests as part of the contract.
