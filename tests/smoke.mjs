import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EmbeddedStorage } from "../dist/index.js";

class Owner {
  constructor(id, name) {
    this.id = id;
    this.name = name;
  }
}

class Document {
  constructor(id, title, owner) {
    this.id = id;
    this.title = title;
    this.owner = owner;
    this.tags = new Set();
    this.links = new Map();
    this.related = [];
  }
}

const types = [
  { name: "Owner", ctor: Owner },
  { name: "Document", ctor: Document },
];

const storageDirectory = await mkdtemp(join(tmpdir(), "graphvault-smoke-"));

try {
  const owner = new Owner("owner-1", "Platform Team");
  const first = new Document("doc-1", "Object graph persistence", owner);
  const second = new Document("doc-2", "Admin workflows", owner);
  first.tags.add("typescript");
  first.tags.add("storage");
  second.links.set("source", first);
  first.related.push(second);

  const storage = await EmbeddedStorage.start({
    storageDirectory,
    root: { documents: [first, second], featured: first },
    types,
  });

  await storage.storeRoot();
  await storage.shutdown();

  const reloaded = await EmbeddedStorage.start({
    storageDirectory,
    rootFactory: () => ({ documents: [] }),
    types,
  });

  assert.equal(reloaded.root.documents.length, 2);
  assert.ok(reloaded.root.documents[0] instanceof Document);
  assert.ok(reloaded.root.documents[1] instanceof Document);
  assert.ok(reloaded.root.documents[0].owner instanceof Owner);
  assert.equal(reloaded.root.documents[0].owner, reloaded.root.documents[1].owner);
  assert.equal(reloaded.root.featured, reloaded.root.documents[0]);
  assert.equal(reloaded.root.documents[1].links.get("source"), reloaded.root.documents[0]);
  assert.equal(reloaded.root.documents[0].related[0], reloaded.root.documents[1]);
  assert.ok(reloaded.root.documents[0].tags.has("typescript"));

  const verification = await reloaded.verify();
  assert.equal(verification.ok, true);
  await reloaded.shutdown();
} finally {
  await rm(storageDirectory, { recursive: true, force: true });
}
