import assert from "node:assert/strict";
import { parseGvql } from "../dist/gvql/gvql-parser.js";

function randomId(seed, index) {
  const base = String.fromCharCode(97 + (index % 26));
  return `${base}${seed}`;
}

function randomQuery(seed) {
  const aliases = [randomId(seed, 0), randomId(seed, 1)];
  const lines = [];
  lines.push(`MATCH (${aliases[0]}:Doc)`);
  if (seed % 3 === 0) {
    lines.push(`WHERE ${aliases[0]}.status = "draft"`);
  }
  if (seed % 5 === 0) {
    lines.push(`WITH ${aliases[0]}.id AS id`);
    lines.push(`WHERE id IS NOT NULL`);
  }
  lines.push(`RETURN ${aliases[0]}.id AS id`);
  if (seed % 2 === 0) {
    lines.push("ORDER BY id ASC");
  }
  if (seed % 7 === 0) {
    lines.push("LIMIT 3");
    lines.push("OFFSET 1");
  }
  if (seed % 11 === 0) {
    lines.push(`,`); // inject malformed punctuation for negative fuzz control
  }
  return lines.join("\n");
}

for (let seed = 0; seed < 200; seed++) {
  const query = randomQuery(seed);
  const lines = query.split("\n");
  const malformedPunctuation = query.includes("OFFSET") && lines.some((line) => line.trim() === ",");
  if (malformedPunctuation) {
    assert.throws(() => parseGvql(query), /GVQL|Unsupported GVQL|Expected GVQL|Invalid GVQL/);
  } else {
    const parsed = parseGvql(query);
    assert.equal(parsed.match.start.alias, randomId(seed, 0));
    assert.equal(parsed.returns.length >= 1, true);
    if (query.includes("ORDER BY")) {
      assert.equal(parsed.orderBy?.length >= 1, true);
    }
  }
}

const invalidSeeds = [
  "MATH (doc)",
  "MATCH (doc",
  "MATCH doc) WHERE doc.id = 1 RETURN doc.id AS id",
  "MATCH (doc) WHERE OR doc.id = \"x\" RETURN doc.id AS id",
  "MATCH ()",
];
for (const query of invalidSeeds) {
  assert.throws(() => parseGvql(query), /GVQL|Expected GVQL/);
}
