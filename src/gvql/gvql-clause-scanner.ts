export type GvqlClauseName =
  | "MATCH"
  | "OPTIONAL MATCH"
  | "WHERE"
  | "WITH"
  | "MERGE"
  | "SET"
  | "REMOVE"
  | "DELETE"
  | "CREATE"
  | "RETURN"
  | "GROUP BY"
  | "HAVING"
  | "ORDER BY"
  | "LIMIT"
  | "OFFSET";

/** Parsed top-level GVQL clause name and body before full statement construction. */
export interface GvqlClause {
  name: GvqlClauseName;
  body: string;
  index: number;
}

const CLAUSE_NAMES: GvqlClauseName[] = [
  "OPTIONAL MATCH",
  "GROUP BY",
  "ORDER BY",
  "MATCH",
  "WHERE",
  "WITH",
  "MERGE",
  "REMOVE",
  "DELETE",
  "CREATE",
  "RETURN",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "SET",
];

/** Splits a GVQL statement into top-level clauses while respecting strings, brackets, and parentheses. */
export function splitGvqlClauses(source: string): GvqlClause[] {
  const normalized = source.trim().replace(/;$/, "");
  const matches: Array<{ name: GvqlClauseName; index: number; end: number }> = [];
  for (let index = 0; index < normalized.length; index++) {
    if (isQuoted(normalized, index)) continue;
    const name = CLAUSE_NAMES.find((candidate) => keywordAt(normalized, index, candidate));
    if (!name) continue;
    if (name === "WITH" && ["STARTS", "ENDS"].includes(previousWord(normalized, index))) continue;
    matches.push({ name, index, end: index + name.length });
    index += name.length - 1;
  }
  if (matches[0]?.name !== "MATCH") {
    throw new Error("GVQL statements must start with MATCH.");
  }
  return matches.map((current, index) => ({
    name: current.name,
    index: current.index,
    body: normalized.slice(current.end, matches[index + 1]?.index).trim(),
  }));
}

/** Groups scanned GVQL clauses by lowercase clause name for parser lookup. */
export function clausesByName(clauses: GvqlClause[]): Map<GvqlClauseName, string> {
  const result = new Map<GvqlClauseName, string>();
  for (const clause of clauses) {
    if (!result.has(clause.name)) result.set(clause.name, clause.body);
  }
  return result;
}

function previousWord(input: string, index: number): string {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(input[cursor] ?? "")) cursor--;
  const end = cursor + 1;
  while (cursor >= 0 && /[A-Za-z]/.test(input[cursor] ?? "")) cursor--;
  return input.slice(cursor + 1, end).toUpperCase();
}

function keywordAt(input: string, index: number, keyword: string): boolean {
  const before = input[index - 1];
  const after = input[index + keyword.length];
  return (
    input.slice(index, index + keyword.length).toUpperCase() === keyword &&
    (!before || /\W/.test(before)) &&
    (!after || /\W/.test(after))
  );
}

function isQuoted(input: string, index: number): boolean {
  let quote: string | undefined;
  for (let cursor = 0; cursor < index; cursor++) {
    const char = input[cursor];
    if ((char === '"' || char === "'") && input[cursor - 1] !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
    }
  }
  return Boolean(quote);
}
