# ACID Configuration

GraphVault is an embedded object-graph store, not a clustered database server. It still provides explicit ACID-oriented controls for applications that need strong local or shared-store write behavior.

## Recommended Production Profile

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data",
  rootFactory: () => ({ documents: [] }),
  lockStrategy: "optimistic",
  transactionLog: "full",
  recoverCommittedWal: true,
  readCommittedWal: true,
  writeDurability: "strict",
  staleLockTimeoutMs: 120_000,
  commitValidators: [
    ({ root }) => {
      for (const document of root.documents) {
        if (!document.id) {
          throw new Error("Document id is required.");
        }
      }
    },
  ],
});
```

## Atomicity And Durability

- `transactionLog: "full"` writes a WAL prepare record with the serialized graph before publishing commit metadata.
- GraphVault writes a commit marker only after the graph data has been written.
- Manifest, parent index, `CURRENT`, and transaction records are published after the commit marker.
- On restart, `recoverCommittedWal: true` finishes any committed-but-not-published WAL entry under the shared writer lock.
- `readCommittedWal: true` lets read-only managers see the latest committed WAL entry even before a writer has repaired the manifest.
- `verify()` checks WAL prepare/commit pairs and reports committed WAL entries that are recoverable but not yet published through manifest metadata.

Set `transactionLog: "off"` only for caches, tests, or stores where maximum throughput is more important than crash recovery.

## Consistency

Use `commitValidators` as hard commit gates for application invariants. Validators run before WAL prepare; if a validator throws, GraphVault writes no prepare record and publishes no commit.

Typical validators enforce required IDs, unique keys, reference integrity, allowed state transitions, or application-specific schema rules.

Verification returns `checkedWalRecords`, `pendingWalCommits`, and `warnings` in addition to object and transaction checks. A non-zero `pendingWalCommits` value means the store has durable committed work that a writer can publish during recovery.

## Isolation

For shared stores, use a short-lived lock strategy:

- `lockStrategy: "pessimistic"` serializes transactions by taking the writer lock before reading.
- `lockStrategy: "optimistic"` reads first, then checks at commit time whether the store changed meanwhile.

Every writer lock has a fencing token. If a stale lock is recovered and a newer pod obtains a newer token, the old pod cannot publish commit metadata or release the newer lock.

## Durability Tradeoffs

- `writeDurability: "strict"` is the production default and favors safer local atomic writes.
- `writeDurability: "relaxed"` favors throughput and is suitable for disposable or rebuildable stores.
- `staleLockTimeoutMs` should be higher than the longest transaction you intentionally allow.

## Remaining Boundary

GraphVault does not implement replicated consensus. If several machines can lose network connectivity from each other but still write to different storage primaries, use a database or coordination layer that provides consensus, such as PostgreSQL with a proper HA setup, etcd, or a database designed for distributed consensus.

Lazy values are stored as separate payload files. The WAL protects the object graph commit metadata and can recover the graph state after a crash. For strict ACID workflows, keep transactional state in the main graph or use immutable/versioned lazy keys for large payloads. Treat in-place updates to existing lazy payload keys as external blob writes, not as fully atomic graph transaction data.
