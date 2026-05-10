import assert from "node:assert/strict";
import { parseGvql } from "../dist/index.js";

function assertParseError(query, expectedMessage) {
  assert.throws(() => parseGvql(query), new RegExp(expectedMessage));
}

const selectStatement = parseGvql(`
  MATCH (doc:Document)-[:owner]->(owner:Owner)
  WHERE owner.name = "Ada"
  RETURN doc.id AS id, owner.name AS ownerName
`);
assert.equal(selectStatement.kind, "select");
assert.equal(selectStatement.match.start.alias, "doc");
assert.equal(selectStatement.match.start.type, "Document");
assert.equal(selectStatement.match.chain.length, 1);
assert.equal(selectStatement.match.chain[0].edge.direction, "out");
assert.equal(selectStatement.match.chain[0].edge.label, "owner");
assert.deepEqual(selectStatement.returns.map((item) => item.aliasName), ["id", "ownerName"]);

assertParseError(`
  RETURN doc.id AS id
`, "GVQL .*must start with MATCH|GVQL requires a MATCH");

assertParseError(`
  MATCH , 
`, "GVQL MATCH is empty");

assertParseError(`
  MATCH (doc:Document) WHERE AND doc.id = "x"
`, "GVQL WHERE is empty");

assertParseError(`
  MATCH (doc:Document) RETURN doc.id AS id HAVING OR count
`, "GVQL HAVING is empty");

assertParseError(`
  MATCH (doc)-[:owner]-(owner) RETURN doc.id AS id
`, "GVQL edge patterns must use either -\\[:label\\]-> or <-\\[:label\\]-");

assertParseError(`
  MATCH (doc) WITH doc.id AS id
  SET doc.name = "x"
  RETURN id
`, "GVQL WITH is currently supported for read queries");

assertParseError(`
  MATCH (doc) CREATE new:Entity { id: "1", name: "demo" } INTO doc.docs
  RETURN new.id
`, "GVQL CREATE requires INTO parent.collection");

assertParseError(`
  MATCH (doc) MERGE (new:Entity { id: "1" }) INTO doc.items
  RETURN new.id
`, "GVQL MERGE requires ON alias.field");

assertParseError(`
  MATCH (doc) RETURN DISTINCT
`, "GVQL RETURN is empty");

assertParseError(`
  MATCH (doc) RETURN count(DISTINCT *) AS allCount
`, "GVQL count\\(DISTINCT .* requires a path expression");

assertParseError(`
  MATCH (doc) RETURN unknown(doc.id) AS value
`, "Unsupported GVQL function \"unknown\"");

const startsWithClause = parseGvql(`
  MATCH (doc)
  WHERE doc.title STARTS WITH "Graph"
  RETURN doc.title AS title
`);
assert.equal(startsWithClause.where.kind, "predicate");
