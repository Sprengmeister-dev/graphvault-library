import { rm } from "node:fs/promises";
import { EmbeddedStorage } from "../dist/index.js";

class Workspace {
  constructor(name) {
    this.name = name;
    this.documents = [];
  }
}

class Document {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.tags = new Set();
    this.createdAt = new Date();
  }
}

const storageDirectory = "./graphvault-example-store";
await rm(storageDirectory, { recursive: true, force: true });

const storage = await EmbeddedStorage.start({
  storageDirectory,
  root: new Workspace("Product research"),
  types: [
    { name: "Workspace", ctor: Workspace },
    { name: "Document", ctor: Document },
  ],
});

const document = new Document("doc-1", "Why object graphs matter");
document.tags.add("architecture");
document.tags.add("typescript");
storage.root.documents.push(document);

await storage.storeRoot();
await storage.shutdown();

const reloaded = await EmbeddedStorage.start({
  storageDirectory,
  rootFactory: () => new Workspace("empty"),
  types: [
    { name: "Workspace", ctor: Workspace },
    { name: "Document", ctor: Document },
  ],
});

console.log(reloaded.root.documents[0]);
await reloaded.shutdown();
