# GraphVault Usage Guide

## TypeScript Usage Guide

### Model Your Root

Use one root object for the part of your application state that belongs together. Plain objects work, but classes are usually nicer for domain-heavy apps.

```ts
import type { LazyRef } from "@sprengmeister/graphvault";

class Workspace {
  documents: Document[] = [];

  constructor(readonly name: string) {}
}

class Document {
  tags = new Set<string>();
  related = new Map<string, Document>();
  attachments = new Map<string, LazyRef<Buffer>>();

  constructor(
    readonly id: string,
    public title: string,
  ) {}
}

type AppRoot = Workspace;
```

### Start A Store

For a new store, `rootFactory` creates the initial root. For an existing store, GraphVault loads the persisted root and ignores the factory result.

```ts
import { EmbeddedStorage } from "@sprengmeister/graphvault";

const storage = await EmbeddedStorage.start<AppRoot>({
  storageDirectory: "./data/graphvault",
  rootFactory: () => new Workspace("Product"),
});
```

For scripts, tests, and bootstrap code, passing a concrete root is often the shortest path:

```ts
const storage = await EmbeddedStorage.start({
  storageDirectory: "./data/graphvault",
  root: new Workspace("Product"),
});
```

### Register Classes

Register classes when you want loaded objects to keep their prototypes and methods.

```ts
const storage = await EmbeddedStorage.start<AppRoot>({
  storageDirectory: "./data/graphvault",
  rootFactory: () => new Workspace("Product"),
  types: [
    { name: "Workspace", ctor: Workspace },
    { name: "Document", ctor: Document },
  ],
});
```

You can version and migrate classes:

```ts
{
  name: "Document",
  ctor: Document,
  version: 2,
  create: () => new Document("", ""),
  migrate: (state, fromVersion) => {
    if (fromVersion < 2) {
      return { ...state, tags: [] };
    }
    return state;
  },
  hydrate: (target, state) => {
    target.title = String(state.title ?? "");
  },
}
```

### Read And Write Data

Mutate your root like normal TypeScript objects, then store explicitly. `storeRoot()` writes the full reachable root graph, so nested changes in arrays, maps, sets, and child objects are durable even when the root object identity did not change.

```ts
const document = new Document("doc-1", "Storage design");
document.tags.add("architecture");

storage.root.documents.push(document);
await storage.storeRoot();
```

For service methods, `update(...)` is the most convenient shape. Without a `storeTarget`, it stores the full root graph after the mutator succeeds and rolls the in-memory root back if the mutator throws.

```ts
await storage.update((root) => {
  root.documents.push(new Document("doc-2", "Operational notes"));
});
```

When you only want to mark specific objects as the write target, use `store(object)`, `storeAll(...)`, or an explicit `storeTarget` for `update(...)`.

```ts
document.title = "Storage design v2";
await storage.store(document);

await storage.storeAll(storage.root.documents);
```

### Bounded Subtree Loading

Use `loadSubtree(...)` when an API should expose only a bounded part of the graph instead of returning the whole root.

```ts
const subtree = await storage.loadSubtree({ depth: 1 });
const documentSubtree = await storage.loadSubtree("document-object-id", { depth: 2 });

console.log(documentSubtree.envelope.nodes);
console.log(documentSubtree.truncatedReferences);
```

`depth: 0` loads only the start object. `depth: 1` adds its directly referenced child objects. The result is a serialized graph envelope plus metadata, so REST clients can see whether the response is complete or where the server intentionally stopped traversal.

### Batch Writes With A Storer

Storers are useful when a workflow touches several objects and you want one commit at the end.

```ts
const storer = storage.createStorer();
storer.store(storage.root);
storer.storeAll(storage.root.documents);
await storer.commit();
```

### Lazy Data

Use `LazyRef` for large values that should live outside the main object graph until loaded.

```ts
const attachment = await storage.createLazyRef("attachments/doc-1", Buffer.from("content"));
storage.root.documents[0].attachments.set("main", attachment);
await storage.storeRoot();

const bytes = await attachment.get();
attachment.clear();
```

### Verification, Maintenance, And Backup

```ts
const operations = await storage.operations();
console.log(operations.status, operations.pendingWalCommits);

const safety = await storage.safetyProfile();
if (safety.status === "unsafe") {
  throw new Error(safety.issues.map((issue) => issue.message).join("\n"));
}

const verification = await storage.verify();
if (!verification.ok) {
  throw new Error(verification.errors.join("\n"));
}

await storage.maintain({ keepSnapshots: 2 });

await storage.backup({
  storageDirectory: "./backups/graphvault",
});
```

`backup(...)` is consistent by default: it takes the writer lock, repairs committed WAL if needed, copies the store, and leaves volatile lock files out of the backup. Use `{ consistent: false }` only for disposable stores or when an infrastructure-level snapshot already provides point-in-time consistency.

### Read-Only Access

Read-only mode is useful for admin jobs, export scripts, and safety checks. It does not acquire the writer lock and refuses mutations.

```ts
const storage = await EmbeddedStorage.start<AppRoot>({
  storageDirectory: "./data/graphvault",
  readOnly: true,
  rootFactory: () => new Workspace("unused"),
});
```

### Shutdown

Always shut the manager down in CLIs, tests, and worker processes so locks and timers are released cleanly.

```ts
try {
  await storage.update((root) => {
    root.documents.push(new Document("doc-3", "Release checklist"));
  });
} finally {
await storage.shutdown();
}
```
