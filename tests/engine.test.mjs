import assert from "node:assert/strict";
import { executeGvqlStatement, GraphSerializer, parseGvql } from "../dist/index.js";

class Item {
  id;
  name;
  views;
  constructor(id, name, views = 0) {
    this.id = id;
    this.name = name;
    this.views = views;
  }
}

const types = [{ name: "Item", ctor: Item }];
const serializer = new GraphSerializer(types);
const root = {
  collection: [new Item("item-1", "Alpha", 10), new Item("item-2", "Beta", 20)],
  status: "ok",
};

const updateWithMissingPermission = parseGvql('MATCH (item:Item) WHERE item.id = "item-1" SET item.name = "Updated" RETURN item.id AS id');
const selectItems = parseGvql('MATCH (item:Item) WHERE item.id = "item-1" RETURN item.name AS name');
const deleteRoot = parseGvql("MATCH (root:Item) DELETE root RETURN root.id AS id");
const badRemove = parseGvql(`
  MATCH (root)-[:collection]->(items)
  REMOVE items.value
  RETURN root.id AS id
`);

const mutableEnvelope = serializer.serialize(root);
const selected = executeGvqlStatement(mutableEnvelope, selectItems);
assert.equal(selected.kind, "select");
assert.deepEqual(selected.rows, [{ name: "Alpha" }]);

const snapshotEnvelope = serializer.serialize(root);
assert.throws(
  () => executeGvqlStatement(snapshotEnvelope, updateWithMissingPermission),
  /GVQL update statements require allowMutations/,
);

const previewEnvelope = serializer.serialize(root);
const preview = executeGvqlStatement(previewEnvelope, updateWithMissingPermission, { dryRun: true, allowMutations: true });
assert.equal(preview.kind, "update");
assert.equal(preview.dryRun, true);
assert.equal(preview.rows[0].id, "item-1");
const unchanged = executeGvqlStatement(previewEnvelope, selectItems);
assert.equal(unchanged.rows[0].name, "Alpha");

const applied = executeGvqlStatement(previewEnvelope, updateWithMissingPermission, { allowMutations: true });
assert.equal(applied.kind, "update");
assert.equal(applied.changed, 1);
const changed = executeGvqlStatement(previewEnvelope, selectItems);
assert.equal(changed.rows[0].name, "Updated");

const rootOnlyEnvelope = serializer.serialize(new Item("root", "Root", 0));
assert.throws(() => executeGvqlStatement(rootOnlyEnvelope, deleteRoot, { allowMutations: true }), /GVQL DELETE cannot delete the root object/);

const badRemoveEnvelope = serializer.serialize(root);
assert.throws(() => executeGvqlStatement(badRemoveEnvelope, badRemove, { allowMutations: true }), /GVQL REMOVE currently supports object fields, not array nodes/);
