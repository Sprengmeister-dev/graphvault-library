import type {
  GvqlCompareOperator,
  GvqlEdgePattern,
  GvqlLiteral,
  GvqlLogicalOperator,
  GvqlMatchPattern,
  GvqlPathExpression,
  GvqlPredicate,
  GvqlReturnExpression,
  GvqlSetExpression,
  GvqlStatement,
  GvqlWhereClause,
  GvqlAggregateFunction,
} from "./gvql-types.js";

type ClauseName = "MATCH" | "WHERE" | "SET" | "RETURN" | "GROUP BY" | "ORDER BY" | "LIMIT";

export function parseGvql(source: string): GvqlStatement {
  const clauses = splitClauses(source);
  const match = clauses.get("MATCH");
  if (!match) {
    throw new Error("GVQL requires a MATCH clause.");
  }
  const set = clauses.get("SET") ? parseSetList(clauses.get("SET") as string) : [];
  const returns = clauses.get("RETURN") ? parseReturnList(clauses.get("RETURN") as string) : defaultReturns(set);
  return {
    kind: set.length > 0 ? "update" : "select",
    match: parseMatch(match),
    ...(clauses.get("WHERE") ? { where: parseWhere(clauses.get("WHERE") as string) } : {}),
    returns,
    set,
    ...(clauses.get("ORDER BY") ? { orderBy: parseOrderBy(clauses.get("ORDER BY") as string) } : {}),
    ...(clauses.get("GROUP BY") ? { groupBy: parseGroupBy(clauses.get("GROUP BY") as string) } : {}),
    ...(clauses.get("LIMIT") ? { limit: parseLimit(clauses.get("LIMIT") as string) } : {}),
  };
}

function splitClauses(source: string): Map<ClauseName, string> {
  const normalized = source.trim().replace(/;$/, "");
  const matches: Array<{ name: ClauseName; index: number; end: number }> = [];
  for (const name of ["MATCH", "WHERE", "SET", "RETURN", "GROUP BY", "ORDER BY", "LIMIT"] as ClauseName[]) {
    const found = findKeyword(normalized, name);
    if (found >= 0) {
      matches.push({ name, index: found, end: found + name.length });
    }
  }
  matches.sort((a, b) => a.index - b.index);
  if (matches[0]?.name !== "MATCH") {
    throw new Error("GVQL statements must start with MATCH.");
  }
  const clauses = new Map<ClauseName, string>();
  for (let index = 0; index < matches.length; index++) {
    const current = matches[index] as { name: ClauseName; index: number; end: number };
    const next = matches[index + 1];
    clauses.set(current.name, normalized.slice(current.end, next?.index).trim());
  }
  return clauses;
}

function parseMatch(pattern: string): GvqlMatchPattern {
  let cursor = 0;
  const start = readNode(pattern, cursor);
  cursor = start.end;
  const chain: GvqlMatchPattern["chain"] = [];
  while (cursor < pattern.length) {
    const edge = readEdge(pattern, cursor);
    const node = readNode(pattern, edge.end);
    chain.push({ edge: edge.edge, node: node.node });
    cursor = node.end;
  }
  return { start: start.node, chain };
}

function readNode(input: string, start: number): { node: { alias: string; type?: string }; end: number } {
  const match = /\s*\(([A-Za-z_][\w]*)(?:\s*:\s*([A-Za-z_][\w]*))?\s*\)/y;
  match.lastIndex = start;
  const result = match.exec(input);
  if (!result) {
    throw new Error(`Expected GVQL node pattern at "${input.slice(start)}".`);
  }
  return { node: { alias: result[1] as string, ...(result[2] ? { type: result[2] } : {}) }, end: match.lastIndex };
}

function readEdge(input: string, start: number): { edge: GvqlEdgePattern; end: number } {
  const edge = /\s*(<-|-) *\[(?::\s*([A-Za-z_][\w]*|\*))?\] *(->|-)/y;
  edge.lastIndex = start;
  const result = edge.exec(input);
  if (!result) {
    throw new Error(`Expected GVQL edge pattern at "${input.slice(start)}".`);
  }
  if (result[1] === "<-" && result[3] === "-") {
    return { edge: { direction: "in", ...(result[2] && result[2] !== "*" ? { label: result[2] } : {}) }, end: edge.lastIndex };
  }
  if (result[1] === "-" && result[3] === "->") {
    return { edge: { direction: "out", ...(result[2] && result[2] !== "*" ? { label: result[2] } : {}) }, end: edge.lastIndex };
  }
  throw new Error("GVQL edge patterns must use either -[:label]-> or <-[:label]-.");
}

function parseWhere(input: string): GvqlWhereClause {
  const parts = splitLogical(input);
  if (parts.length === 0) {
    throw new Error("GVQL WHERE is empty.");
  }
  const [first, ...rest] = parts as [{ text: string; operator?: GvqlLogicalOperator }, ...Array<{ text: string; operator?: GvqlLogicalOperator }>];
  return {
    first: parsePredicate(first.text),
    rest: rest.map((part) => ({ operator: part.operator as GvqlLogicalOperator, predicate: parsePredicate(part.text) })),
  };
}

function parsePredicate(input: string): GvqlPredicate {
  for (const operator of ["STARTS WITH", "ENDS WITH", "CONTAINS", "!=", ">=", "<=", "=", ">", "<", "IN"] as GvqlCompareOperator[]) {
    const index = findOperator(input, operator);
    if (index >= 0) {
      return {
        left: parsePathExpression(input.slice(0, index).trim()),
        operator,
        right: parseValueOrPath(input.slice(index + operator.length).trim()),
      };
    }
  }
  throw new Error(`Unsupported GVQL predicate "${input}".`);
}

function parseSetList(input: string): GvqlSetExpression[] {
  return splitComma(input).map((item) => {
    const index = findOperator(item, "=");
    if (index < 0) {
      throw new Error(`GVQL SET item needs "=": ${item}`);
    }
    return {
      target: parsePathExpression(item.slice(0, index).trim()),
      value: parseValueOrPath(item.slice(index + 1).trim()),
    };
  });
}

function parseReturnList(input: string): GvqlReturnExpression[] {
  return splitComma(input).map((item) => {
    const { expression, aliasName } = splitAlias(item);
    if (expression === "*") return { kind: "all", ...(aliasName ? { aliasName } : {}) };
    const count = /^count\s*\(\s*(\*|[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)\s*\)$/i.exec(expression);
    if (count) {
      const countExpression = count[1] && count[1] !== "*" ? parsePathExpression(count[1]) : undefined;
      return { kind: "count", ...(countExpression ? { expression: countExpression } : {}), ...(aliasName ? { aliasName } : {}) };
    }
    const aggregate = /^(sum|avg|min|max)\s*\(\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)\s*\)$/i.exec(expression);
    if (aggregate) {
      return {
        kind: "aggregate",
        fn: aggregate[1]?.toLowerCase() as Exclude<GvqlAggregateFunction, "count">,
        expression: parsePathExpression(aggregate[2] as string),
        ...(aliasName ? { aliasName } : {}),
      };
    }
    if (/^[A-Za-z_][\w]*$/.test(expression)) return { kind: "all", alias: expression, ...(aliasName ? { aliasName } : {}) };
    return { kind: "path", expression: parsePathExpression(expression), ...(aliasName ? { aliasName } : {}) };
  });
}

function parseGroupBy(input: string): GvqlPathExpression[] {
  return splitComma(input).map(parsePathExpression);
}

function parseOrderBy(input: string): { expression: GvqlPathExpression; direction: "asc" | "desc" } {
  const match = /^(.*?)(?:\s+(ASC|DESC))?$/i.exec(input.trim());
  if (!match) throw new Error(`Invalid GVQL ORDER BY "${input}".`);
  return { expression: parsePathExpression((match[1] ?? "").trim()), direction: match[2]?.toLowerCase() === "desc" ? "desc" : "asc" };
}

function parseLimit(input: string): number {
  const value = Number(input.trim());
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid GVQL LIMIT "${input}".`);
  }
  return value;
}

function defaultReturns(set: GvqlSetExpression[]): GvqlReturnExpression[] {
  return set.length > 0 ? [{ kind: "count", aliasName: "changed" }] : [{ kind: "all" }];
}

function parsePathExpression(input: string): GvqlPathExpression {
  const [alias, ...path] = input.split(".");
  if (!alias || !/^[A-Za-z_][\w]*$/.test(alias)) {
    throw new Error(`Invalid GVQL path expression "${input}".`);
  }
  return { alias, ...(path.length ? { path: path.join(".") } : {}) };
}

function parseValueOrPath(input: string): GvqlLiteral | GvqlPathExpression {
  if (/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(input)) {
    return parsePathExpression(input);
  }
  return parseLiteral(input);
}

function parseLiteral(input: string): GvqlLiteral {
  const trimmed = input.trim();
  if (trimmed.startsWith("$")) return { parameter: trimmed.slice(1) };
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return unquote(trimmed);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const body = trimmed.slice(1, -1).trim();
    return body ? splitComma(body).map(parseLiteral) : [];
  }
  throw new Error(`Unsupported GVQL literal "${input}". Use strings, numbers, booleans, null, arrays, or $parameters.`);
}

function splitLogical(input: string): Array<{ operator?: GvqlLogicalOperator; text: string }> {
  const result: Array<{ operator?: GvqlLogicalOperator; text: string }> = [];
  let cursor = 0;
  let currentOperator: GvqlLogicalOperator | undefined;
  for (let index = 0; index < input.length; index++) {
    const operator = keywordAt(input, index, "AND") ? "AND" : keywordAt(input, index, "OR") ? "OR" : undefined;
    if (!operator || isQuoted(input, index)) continue;
    result.push({ ...(currentOperator ? { operator: currentOperator } : {}), text: input.slice(cursor, index).trim() });
    currentOperator = operator;
    index += operator.length - 1;
    cursor = index + 1;
  }
  result.push({ ...(currentOperator ? { operator: currentOperator } : {}), text: input.slice(cursor).trim() });
  return result.filter((part) => part.text);
}

function splitComma(input: string): string[] {
  const parts: string[] = [];
  let cursor = 0;
  let depth = 0;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (isQuoted(input, index)) continue;
    if (char === "[" || char === "(") depth++;
    if (char === "]" || char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(input.slice(cursor, index).trim());
      cursor = index + 1;
    }
  }
  parts.push(input.slice(cursor).trim());
  return parts.filter(Boolean);
}

function splitAlias(input: string): { expression: string; aliasName?: string } {
  const index = findKeyword(input, "AS");
  if (index < 0) return { expression: input.trim() };
  return { expression: input.slice(0, index).trim(), aliasName: input.slice(index + 2).trim() };
}

function findKeyword(input: string, keyword: string): number {
  for (let index = 0; index < input.length; index++) {
    if (!isQuoted(input, index) && keywordAt(input, index, keyword)) return index;
  }
  return -1;
}

function findOperator(input: string, operator: string): number {
  for (let index = 0; index < input.length; index++) {
    if (!isQuoted(input, index) && input.slice(index, index + operator.length).toUpperCase() === operator) return index;
  }
  return -1;
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

function unquote(input: string): string {
  return input.slice(1, -1).replace(/\\(["'\\nrt])/g, (_, char: string) => {
    if (char === "n") return "\n";
    if (char === "r") return "\r";
    if (char === "t") return "\t";
    return char;
  });
}
