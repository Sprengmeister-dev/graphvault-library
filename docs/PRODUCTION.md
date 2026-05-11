# Production Operations

This guide is for teams that want to run GraphVault on important data with predictable behavior, clear recovery steps, and auditable operational routines.

GraphVault is an embedded object-graph database. It can be used by several pods when they share a storage target that implements atomic writes, writer locks, and fencing tokens. It is not a replicated consensus database: if you need automatic cross-region leader election, quorum replication, roles, or SQL server semantics, keep using a server database for that part of the system.

## Recommended Profiles

### Critical Shared Store

Use this profile when several application pods write to the same store.

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "graphvault/prod",
  root,
  storageTarget,
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
      if (root.ledger.total < 0) {
        throw new Error("Ledger total must not become negative.");
      }
    },
  ],
});
```

Use `transaction(...)` for related mutations. The pessimistic transaction mode takes the shared writer lock before reading and holds it until commit, so other writers cannot interleave changes.

### High-Throughput Embedded Store

Use this profile for write-heavy local stores where the application owns the process and can rebuild from upstream truth if needed.

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "graphvault/cache",
  root,
  lockStrategy: "startup",
  transactionLog: "off",
  writeProfile: "maximum",
  writeDurability: "relaxed",
  writeSnapshots: false,
});
```

This favors throughput over recovery metadata. Do not use it for financial ledgers, audit trails, or irreplaceable state.

### Optimistic Multi-Pod Store

Use this profile when conflicts are rare and you want shorter lock hold times.

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "graphvault/prod",
  root,
  storageTarget,
  lockStrategy: "optimistic",
  optimisticMaxRetries: 5,
  optimisticRetryDelayMs: 50,
  staleLockTimeoutMs: 120_000,
  transactionLog: "full",
  writeDurability: "strict",
});
```

Optimistic transactions reload the latest store, run the mutation, acquire the lock, and check that the transaction id has not changed before publishing. If another writer won the race, GraphVault retries or throws `OptimisticLockError`.

## Storage Target Requirements

For production shared stores, the target must provide:

- atomic object writes for manifest, WAL, transaction records, and object records
- a writer lock visible to every pod that can write to the same store
- monotonically increasing fencing tokens for recovered locks
- token-aware lock release so stale writers cannot delete a newer lock
- read-after-write consistency for commit metadata

The local filesystem target is suitable for a single host or a filesystem that preserves these semantics. Object-storage and SQL-backed targets should be tested in the exact infrastructure configuration you will run in production.

## Commit Path

With `transactionLog: "full"`, a commit follows this order:

1. Serialize the in-memory graph.
2. Run `commitValidators`.
3. Write a WAL prepare record containing the full envelope.
4. Write changed object records under transaction-versioned record names.
5. Write the snapshot when snapshots are enabled.
6. Validate the lock fencing token.
7. Write the WAL commit marker.
8. Write the transaction record with envelope hash, previous hash, and transaction hash.
9. Publish parent index and `CURRENT`.
10. Publish `manifest.json` last, including the latest transaction hash.

If the process crashes after the WAL commit marker but before manifest publication, GraphVault can recover the committed transaction. The next writer repairs the metadata under the shared lock. Readers can also see the committed WAL envelope when `readCommittedWal` is enabled. Because object records are versioned and `manifest.json` selects the exact live version, old manifests do not accidentally read partially written newer child records. The normal test suite includes a WAL crash matrix that exercises failures before the commit marker and at every post-marker publication step.

Transaction records form a tamper-evident SHA-256 hash chain. `verify()` recomputes transaction hashes, checks predecessor links, compares snapshot envelope hashes when snapshots exist, and checks that `manifest.json` points at the latest transaction hash. This is meant for auditability and corruption detection; it does not replace external signatures, immutable object-lock storage, or replicated consensus.

## Backup And Restore

Application-level backups are consistent by default. `backup(...)` takes the shared writer lock, repairs committed WAL entries if needed, copies the store, and excludes volatile lock files from the destination.

```ts
await storage.backup({
  storageDirectory: "graphvault-backups/2026-05-11",
});
```

Do not call `backup(...)` from inside an active `transaction(...)`; both operations need the same consistency boundary. If your infrastructure provides a point-in-time snapshot for the complete storage prefix, you can also use that directly.

For shared storage targets, prefer infrastructure-native snapshots when they preserve point-in-time consistency across the whole storage prefix.

Restore procedure:

1. Stop all writers.
2. Restore the complete GraphVault storage directory or prefix.
3. Start one writer with `recoverCommittedWal: true`.
4. Run `await storage.verify()`.
5. Start the remaining pods only after verification reports `ok: true`.

## Verification And Monitoring

Run `verify()`:

- after restore
- after deployment changes involving storage targets
- before and after manual maintenance
- on a schedule for critical stores

Important fields:

- `ok`: `true` means no structural errors were found.
- `checkedObjects`: object records checked against the manifest.
- `checkedTransactions`: transaction records checked.
- `checkedWalRecords`: WAL prepare/commit records checked.
- `checkedIntegrityHashes`: transaction-chain, manifest, and snapshot hashes checked.
- `pendingWalCommits`: committed WAL entries that can be published by recovery.
- `warnings`: recoverable or operationally interesting conditions.
- `errors`: structural integrity failures.

Alert if:

- `ok` is false
- `pendingWalCommits` stays above zero after a writer restart
- `checkedIntegrityHashes` unexpectedly drops to zero on a critical store
- lock acquisition times out repeatedly
- stale-lock recovery happens unexpectedly often
- object storage or SQL target operations return consistency or conditional-write errors

## Financial And Audit Workloads

For money-like state, keep invariant checks close to the commit boundary:

- use `transaction(...)` for every business mutation
- use `commitValidators` for non-negotiable invariants
- write audit events into the same root graph as the state change
- attach transaction metadata with actor, reason, source, and trace ID so operational history can be tied back to application events
- keep `transactionLog: "full"` and `writeDurability: "strict"`
- do not update existing lazy payload keys in place for transactional facts
- run verification before and after restore drills

GraphVault can protect the graph commit path, but it cannot prove that application-level accounting rules are correct. Treat validators and tests as part of the database contract.

## Known Boundaries

- GraphVault does not provide replicated consensus or automatic failover leadership.
- Lazy payload files are separate blob writes. Keep strict transactional state in the main graph or use immutable/versioned lazy keys.
- Long-running transactions hold or risk conflicts on the shared writer path. Keep transaction callbacks deterministic and short.
- All writers must use the same storage target configuration and a compatible GraphVault version.
- External tools should not mutate GraphVault storage files directly.

## Deployment Checklist

- Use a storage target with verified atomic writes, locking, fencing, and read-after-write behavior.
- Configure `transactionLog: "full"` for critical data.
- Configure `staleLockTimeoutMs` above the longest accepted transaction runtime.
- Run the concurrency and storage-target tests against production-like infrastructure.
- Define `commitValidators` for domain invariants.
- Document backup, restore, and verification runbooks.
- Monitor verification, lock timeouts, stale-lock recovery, and storage-target errors.
