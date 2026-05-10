import assert from "node:assert/strict";
import { GraphSerializer } from "../dist/core/serializer.js";
import { buildGvqlGraphIndex, propertyIndexKey, referencedEdges, visitEncodedNode } from "../dist/gvql/gvql-index.js";

class Document {
  constructor(id, status, title, owner) {
    this.id = id;
    this.status = status;
    this.title = title;
    this.owner = owner;
  }
}

class Owner {
  constructor(id, region) {
    this.id = id;
    this.region = region;
  }
}

const owner = new Owner("owner-1", "eu");
const first = new Document("doc-1", "draft", "Hello", owner);
const second = new Document("doc-2", "published", "World", owner);
const serializer = new GraphSerializer([
  { name: "Document", ctor: Document },
  { name: "Owner", ctor: Owner },
]);

const envelope = serializer.serialize({
  documents: [first, second],
});
const index = buildGvqlGraphIndex(envelope);

assert.equal(index.nodes.size, 5);
assert.equal(index.byType.get("Document")?.length, 2);
assert.equal(index.byType.get("Owner")?.length, 1);
assert.equal(index.byProperty.has(propertyIndexKey("Document", "status", "draft")), true);
assert.equal(index.byProperty.has(propertyIndexKey(undefined, "status", "draft")), true);

const root = envelope.nodes[index.nodes.keys().next().value];
const outgoingFromRoot = index.outgoing.get(index.nodes.keys().next().value);
assert.equal(Array.isArray(outgoingFromRoot), true);

const visited = [];
for (const [path, node] of Object.entries(envelope.nodes)) {
  visitEncodedNode(node, (nodePath, value) => {
    if (typeof value === "object" && value !== null && "$ref" in value) {
      visited.push({ from: path, via: nodePath, to: value.$ref });
    }
  });
}
assert.ok(visited.length >= 2);

const referenced = visited.flatMap(({ from, via, to }) => referencedEdges(from, envelope.nodes[from]).filter((edge) => edge.path === via && edge.to === to));
assert.equal(referenced.length, visited.length);

const rootDocsId = envelope.root.$ref;
assert.equal(Array.isArray(index.byType.get("Document")), true);
assert.equal(propertyIndexKey("Owner", "region", "eu"), `Owner${"\u0000"}region${"\u0000"}string:eu`);
