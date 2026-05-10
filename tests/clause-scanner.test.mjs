import assert from "node:assert/strict";
import { clausesByName, splitGvqlClauses } from "../dist/gvql/gvql-clause-scanner.js";

const baseQuery = `
  MATCH (doc:Document)
  WHERE doc.title = "Object Vault"
  RETURN doc.id AS id, doc.title AS title
  ORDER BY doc.id ASC
  LIMIT 5
  OFFSET 2
`;

const clauses = splitGvqlClauses(baseQuery);
assert.equal(clauses.length, 6);
assert.equal(clauses[0].name, "MATCH");
assert.equal(clauses[1].name, "WHERE");
assert.equal(clauses[2].name, "RETURN");
assert.equal(clauses[3].name, "ORDER BY");
assert.equal(clauses[4].name, "LIMIT");
assert.equal(clauses[4].body.startsWith("5"), true);
assert.equal(clausesByName(clauses).get("LIMIT"), "5");
assert.equal(clausesByName(clauses).get("OFFSET"), "2");

assert.equal(clausesByName(clauses).size, 6);
assert.equal(clausesByName(clauses).get("MATCH"), "(doc:Document)");
assert.equal(clausesByName(clauses).get("ORDER BY"), "doc.id ASC");

const quotedKeywordQuery = `MATCH (doc) WHERE doc.title = "RETURN count(*) should not split" RETURN doc.id AS id`;
const quotedClauses = splitGvqlClauses(quotedKeywordQuery);
assert.equal(quotedClauses.length, 3);
assert.equal(quotedClauses[0].name, "MATCH");
assert.equal(quotedClauses[1].name, "WHERE");
assert.equal(quotedClauses[2].name, "RETURN");

const withQuery = `
  MATCH (doc:Document)
  RETURN doc.id AS id
  WITH id
  WHERE id IS NOT NULL
  MATCH (doc)-[:related]->(rel)
  RETURN rel.id AS relatedId
`;
const withClauses = splitGvqlClauses(withQuery);
assert.equal(withClauses.map((clause) => clause.name).join(","), "MATCH,RETURN,WITH,WHERE,MATCH,RETURN");

assert.equal(clausesByName(withClauses).get("MATCH"), "(doc:Document)");
assert.equal(clausesByName(withClauses).get("WHERE"), "id IS NOT NULL");

assert.throws(() => splitGvqlClauses("RETURN doc.id"), /must start with MATCH/);
assert.throws(() => splitGvqlClauses("MATH (doc)"), /must start with MATCH/);
assert.equal(splitGvqlClauses("MATCH (doc);").length, 1);
