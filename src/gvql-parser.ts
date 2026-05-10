import { clausesByName, splitGvqlClauses, type GvqlClause } from "./gvql-clause-scanner.js";
import type {
  GvqlCompareOperator,
  GvqlBooleanExpression,
  GvqlCreateExpression,
  GvqlDeleteExpression,
  GvqlEdgePattern,
  GvqlHavingClause,
  GvqlLiteral,
  GvqlLogicalOperator,
  GvqlMatchPattern,
  GvqlOrderExpression,
  GvqlPathExpression,
  GvqlPredicate,
  GvqlRemoveExpression,
  GvqlRowPredicate,
  GvqlReturnExpression,
  GvqlScalarFunction,
  GvqlSetExpression,
  GvqlValueExpression,
  GvqlStatement,
  GvqlWithClause,
  GvqlWhereClause,
  GvqlAggregateFunction,
} from "./gvql-types.js";

export function parseGvql(source: string): GvqlStatement {
  const clauseList = splitGvqlClauses(source);
  const clauses = clausesByName(clauseList);
  const match = clauses.get("MATCH");
  if (!match) {
    throw new Error("GVQL requires a MATCH clause.");
  }
  const set = clauses.get("SET") ? parseSetList(clauses.get("SET") as string) : [];
  const remove = clauses.get("REMOVE") ? parseRemoveList(clauses.get("REMOVE") as string) : [];
  const deleteItems = clauses.get("DELETE") ? parseDeleteList(clauses.get("DELETE") as string) : [];
  const create = clauses.get("CREATE") ? parseCreateList(clauses.get("CREATE") as string) : [];
  const withClause = parseWithFromClauses(clauseList);
  if (withClause && (set.length > 0 || remove.length > 0 || deleteItems.length > 0 || create.length > 0)) {
    throw new Error("GVQL WITH is currently supported for read queries. Use RETURN directly for mutation previews.");
  }
  const rowAliases = withClause ? new Set(withClause.returns.map(returnExpressionOutputName).filter(Boolean) as string[]) : undefined;
  const returnClause = clauses.get("RETURN")
    ? parseReturnClause(clauses.get("RETURN") as string, rowAliases ? { rowAliases } : {})
    : { returns: defaultReturns(set, remove, deleteItems, create), distinct: false };
  const matches = parseMatchList(match);
  return {
    kind: set.length > 0 || remove.length > 0 || deleteItems.length > 0 || create.length > 0 ? "update" : "select",
    match: matches[0] as GvqlMatchPattern,
    matches,
    optionalMatches: clauses.get("OPTIONAL MATCH") ? parseMatchList(clauses.get("OPTIONAL MATCH") as string) : [],
    ...(objectWhereClause(clauseList) ? { where: parseWhere(objectWhereClause(clauseList) as string) } : {}),
    ...(withClause ? { with: withClause } : {}),
    returns: returnClause.returns,
    distinct: returnClause.distinct,
    set,
    remove,
    delete: deleteItems,
    create,
    ...(clauses.get("ORDER BY") ? { orderBy: parseOrderBy(clauses.get("ORDER BY") as string) } : {}),
    ...(clauses.get("GROUP BY") ? { groupBy: parseGroupBy(clauses.get("GROUP BY") as string) } : {}),
    ...(clauses.get("HAVING") ? { having: parseHaving(clauses.get("HAVING") as string) } : {}),
    ...(clauses.get("LIMIT") ? { limit: parseLimit(clauses.get("LIMIT") as string) } : {}),
    ...(clauses.get("OFFSET") ? { offset: parseOffset(clauses.get("OFFSET") as string) } : {}),
  };
}

function parseWithFromClauses(clauses: GvqlClause[]): GvqlWithClause | undefined {
  const withClause = clauses.find((clause) => clause.name === "WITH");
  if (!withClause) return undefined;
  const rowWhere = clauses.find((clause) => clause.name === "WHERE" && clause.index > withClause.index);
  const parsed = parseReturnClause(withClause.body);
  return {
    returns: parsed.returns,
    distinct: parsed.distinct,
    ...(rowWhere ? { where: parseHaving(rowWhere.body) } : {}),
  };
}

function objectWhereClause(clauses: GvqlClause[]): string | undefined {
  const withClause = clauses.find((clause) => clause.name === "WITH");
  const whereClause = clauses.find((clause) => clause.name === "WHERE" && (!withClause || clause.index < withClause.index));
  return whereClause?.body;
}

function parseMatchList(patterns: string): GvqlMatchPattern[] {
  const parsed = splitComma(patterns).map(parseMatch);
  if (parsed.length === 0) {
    throw new Error("GVQL MATCH is empty.");
  }
  return parsed;
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
  return parseBooleanExpression(input, parsePredicate, "WHERE");
}

function parseHaving(input: string): GvqlHavingClause {
  return parseBooleanExpression(input, parseRowPredicate, "HAVING");
}

function parseBooleanExpression<TPredicate>(
  input: string,
  parseLeaf: (input: string) => TPredicate,
  clauseName: "WHERE" | "HAVING",
): GvqlBooleanExpression<TPredicate> {
  const trimmed = stripOuterParentheses(input.trim());
  if (!trimmed) {
    throw new Error(`GVQL ${clauseName} is empty.`);
  }
  const orIndex = findTopLevelLogicalOperator(trimmed, "OR");
  if (orIndex >= 0) {
    return {
      kind: "logical",
      operator: "OR",
      left: parseBooleanExpression(trimmed.slice(0, orIndex), parseLeaf, clauseName),
      right: parseBooleanExpression(trimmed.slice(orIndex + "OR".length), parseLeaf, clauseName),
    };
  }
  const andIndex = findTopLevelLogicalOperator(trimmed, "AND");
  if (andIndex >= 0) {
    return {
      kind: "logical",
      operator: "AND",
      left: parseBooleanExpression(trimmed.slice(0, andIndex), parseLeaf, clauseName),
      right: parseBooleanExpression(trimmed.slice(andIndex + "AND".length), parseLeaf, clauseName),
    };
  }
  if (keywordAt(trimmed, 0, "NOT")) {
    return { kind: "not", expression: parseBooleanExpression(trimmed.slice("NOT".length), parseLeaf, clauseName) };
  }
  return { kind: "predicate", predicate: parseLeaf(trimmed) };
}

function parsePredicate(input: string): GvqlPredicate {
  for (const operator of [
    "IS NOT NULL",
    "IS NULL",
    "STARTS WITH",
    "ENDS WITH",
    "CONTAINS",
    "!=",
    ">=",
    "<=",
    "=",
    ">",
    "<",
    "IN",
  ] as GvqlCompareOperator[]) {
    const index = findOperator(input, operator);
    if (index >= 0) {
      if (operator === "IS NULL" || operator === "IS NOT NULL") {
        return {
          left: parseValueExpression(input.slice(0, index).trim()),
          operator,
          right: null,
        };
      }
      return {
        left: parseValueExpression(input.slice(0, index).trim()),
        operator,
        right: parseValueExpression(input.slice(index + operator.length).trim()),
      };
    }
  }
  throw new Error(`Unsupported GVQL predicate "${input}".`);
}

function parseRowPredicate(input: string): GvqlRowPredicate {
  for (const operator of [
    "IS NOT NULL",
    "IS NULL",
    "STARTS WITH",
    "ENDS WITH",
    "CONTAINS",
    "!=",
    ">=",
    "<=",
    "=",
    ">",
    "<",
    "IN",
  ] as GvqlCompareOperator[]) {
    const index = findOperator(input, operator);
    if (index >= 0) {
      if (operator === "IS NULL" || operator === "IS NOT NULL") {
        return {
          left: parseRowReference(input.slice(0, index).trim()),
          operator,
          right: null,
        };
      }
      return {
        left: parseRowReference(input.slice(0, index).trim()),
        operator,
        right: parseRowValueOrLiteral(input.slice(index + operator.length).trim()),
      };
    }
  }
  throw new Error(`Unsupported GVQL HAVING predicate "${input}".`);
}

function parseSetList(input: string): GvqlSetExpression[] {
  return splitComma(input).map((item) => {
    const index = findOperator(item, "=");
    if (index < 0) {
      throw new Error(`GVQL SET item needs "=": ${item}`);
    }
    return {
      target: parsePathExpression(item.slice(0, index).trim()),
      value: parseValueExpression(item.slice(index + 1).trim()),
    };
  });
}

function parseRemoveList(input: string): GvqlRemoveExpression[] {
  return splitComma(input).map((item) => ({ target: parsePathExpression(item) }));
}

function parseDeleteList(input: string): GvqlDeleteExpression[] {
  return splitComma(input).map((item) => {
    const alias = item.trim();
    if (!/^[A-Za-z_][\w]*$/.test(alias)) {
      throw new Error(`GVQL DELETE expects aliases, for example DELETE doc. Invalid item: "${item}".`);
    }
    return { alias };
  });
}

function parseCreateList(input: string): GvqlCreateExpression[] {
  return splitComma(input).map(parseCreateItem);
}

function parseCreateItem(input: string): GvqlCreateExpression {
  const intoIndex = findKeyword(input, "INTO");
  if (intoIndex < 0) {
    throw new Error("GVQL CREATE requires INTO parent.collection so created objects stay reachable.");
  }
  const pattern = input.slice(0, intoIndex).trim();
  const into = parsePathExpression(input.slice(intoIndex + "INTO".length).trim());
  const match = /^\(\s*([A-Za-z_][\w]*)(?:\s*:\s*([A-Za-z_][\w]*))?\s*(?:\{(.*)\})?\s*\)$/s.exec(pattern);
  if (!match) {
    throw new Error(`Invalid GVQL CREATE pattern "${pattern}". Use CREATE (alias:Type { field: value }) INTO parent.collection.`);
  }
  return {
    alias: match[1] as string,
    ...(match[2] ? { type: match[2] } : {}),
    props: parseObjectProperties(match[3] ?? ""),
    into,
  };
}

function parseObjectProperties(input: string): Record<string, GvqlValueExpression> {
  const props: Record<string, GvqlValueExpression> = {};
  const body = input.trim();
  if (!body) return props;
  for (const item of splitComma(body)) {
    const index = findTopLevelColon(item);
    if (index < 0) {
      throw new Error(`GVQL CREATE property needs ":": ${item}`);
    }
    const key = parseObjectPropertyName(item.slice(0, index).trim());
    props[key] = parseValueExpression(item.slice(index + 1).trim());
  }
  return props;
}

function parseObjectPropertyName(input: string): string {
  if (/^[A-Za-z_][\w]*$/.test(input)) return input;
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) return unquote(input);
  throw new Error(`Invalid GVQL CREATE property name "${input}".`);
}

function parseReturnClause(input: string, options: { rowAliases?: Set<string> } = {}): { returns: GvqlReturnExpression[]; distinct: boolean } {
  const trimmed = input.trim();
  const distinct = keywordAt(trimmed, 0, "DISTINCT");
  const body = distinct ? trimmed.slice("DISTINCT".length).trim() : trimmed;
  if (!body) {
    throw new Error("GVQL RETURN is empty.");
  }
  return { returns: parseReturnList(body, options), distinct };
}

function parseReturnList(input: string, options: { rowAliases?: Set<string> } = {}): GvqlReturnExpression[] {
  return splitComma(input).map((item) => {
    const { expression, aliasName } = splitAlias(item);
    if (expression === "*") return { kind: "all", ...(aliasName ? { aliasName } : {}) };
    if (/^[A-Za-z_][\w]*$/.test(expression) && options.rowAliases?.has(expression)) {
      return { kind: "row", source: expression, ...(aliasName ? { aliasName } : {}) };
    }
    const count = /^count\s*\(\s*(?:(DISTINCT)\s+)?(\*|[A-Za-z_][\w]*(?:\.[^)]+)?)\s*\)$/i.exec(expression);
    if (count) {
      const distinct = Boolean(count[1]);
      if (distinct && count[2] === "*") {
        throw new Error("GVQL count(DISTINCT ...) requires a path expression.");
      }
      const countExpression = count[2] && count[2] !== "*" ? parsePathExpression(count[2]) : undefined;
      return {
        kind: "count",
        ...(countExpression ? { expression: countExpression } : {}),
        ...(distinct ? { distinct } : {}),
        ...(aliasName ? { aliasName } : {}),
      };
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
    if (!aliasName && isPathExpressionSource(expression)) {
      return { kind: "path", expression: parsePathExpression(expression) };
    }
    if (aliasName || isValueExpression(expression)) {
      return { kind: "value", expression: parseValueExpression(expression), source: expression, ...(aliasName ? { aliasName } : {}) };
    }
    return { kind: "path", expression: parsePathExpression(expression) };
  });
}

function returnExpressionOutputName(expression: GvqlReturnExpression): string | undefined {
  if (expression.aliasName) return expression.aliasName;
  if (expression.kind === "path") return [expression.expression.alias, expression.expression.path].filter(Boolean).join(".");
  if (expression.kind === "value") return expression.source;
  if (expression.kind === "row") return expression.source;
  if (expression.kind === "count") return "count";
  if (expression.kind === "aggregate") return `${expression.fn}.${expression.expression.alias}.${expression.expression.path ?? ""}`;
  return expression.alias;
}

function parseGroupBy(input: string): GvqlPathExpression[] {
  return splitComma(input).map(parsePathExpression);
}

function parseOrderBy(input: string): Array<{ expression: GvqlOrderExpression; direction: "asc" | "desc" }> {
  return splitComma(input).map(parseOrderByItem);
}

function parseOrderByItem(input: string): { expression: GvqlOrderExpression; direction: "asc" | "desc" } {
  const match = /^(.*?)(?:\s+(ASC|DESC))?$/i.exec(input.trim());
  if (!match) throw new Error(`Invalid GVQL ORDER BY "${input}".`);
  return { expression: parseOrderExpression((match[1] ?? "").trim()), direction: match[2]?.toLowerCase() === "desc" ? "desc" : "asc" };
}

function parseLimit(input: string): number {
  const value = Number(input.trim());
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid GVQL LIMIT "${input}".`);
  }
  return value;
}

function parseOffset(input: string): number {
  const value = Number(input.trim());
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid GVQL OFFSET "${input}".`);
  }
  return value;
}

function defaultReturns(
  set: GvqlSetExpression[],
  remove: GvqlRemoveExpression[] = [],
  deleteItems: GvqlDeleteExpression[] = [],
  create: GvqlCreateExpression[] = [],
): GvqlReturnExpression[] {
  return set.length > 0 || remove.length > 0 || deleteItems.length > 0 || create.length > 0 ? [{ kind: "count", aliasName: "changed" }] : [{ kind: "all" }];
}

function parsePathExpression(input: string): GvqlPathExpression {
  const [alias, ...path] = input.split(".");
  if (!alias || !/^[A-Za-z_][\w]*$/.test(alias)) {
    throw new Error(`Invalid GVQL path expression "${input}".`);
  }
  return { alias, ...(path.length ? { path: path.join(".") } : {}) };
}

function parseOrderExpression(input: string): GvqlOrderExpression {
  if (/^[A-Za-z_][\w]*$/.test(input)) return { kind: "alias", aliasName: input };
  return { kind: "path", expression: parsePathExpression(input) };
}

function parseRowReference(input: string): { aliasName: string } {
  if (/^[A-Za-z_][\w]*$/.test(input)) return { aliasName: input };
  throw new Error(`Invalid GVQL row reference "${input}". Use a RETURN alias in HAVING.`);
}

function parseValueOrPath(input: string): GvqlLiteral | GvqlPathExpression {
  if (isPathExpressionSource(input)) {
    return parsePathExpression(input);
  }
  return parseLiteral(input);
}

function parseValueExpression(input: string): GvqlValueExpression {
  const trimmed = stripOuterParentheses(input.trim());
  const caseExpression = parseCaseExpression(trimmed);
  if (caseExpression) return caseExpression;
  const additive = findTopLevelArithmeticOperator(trimmed, ["+", "-"]);
  if (additive) {
    return {
      kind: "binary",
      operator: additive.operator,
      left: parseValueExpression(trimmed.slice(0, additive.index)),
      right: parseValueExpression(trimmed.slice(additive.index + 1)),
    };
  }
  const multiplicative = findTopLevelArithmeticOperator(trimmed, ["*", "/"]);
  if (multiplicative) {
    return {
      kind: "binary",
      operator: multiplicative.operator,
      left: parseValueExpression(trimmed.slice(0, multiplicative.index)),
      right: parseValueExpression(trimmed.slice(multiplicative.index + 1)),
    };
  }
  const call = parseFunctionCall(trimmed);
  if (call) return call;
  return parseValueOrPath(trimmed);
}

function parseCaseExpression(input: string): Extract<GvqlValueExpression, { kind: "case" }> | undefined {
  if (!keywordAt(input, 0, "CASE")) return undefined;
  const endIndex = lastTopLevelCaseEnd(input);
  if (endIndex < 0 || input.slice(endIndex + "END".length).trim()) {
    throw new Error('GVQL CASE expressions must end with "END".');
  }
  const body = input.slice("CASE".length, endIndex).trim();
  if (!keywordAt(body, 0, "WHEN")) {
    throw new Error('GVQL CASE expressions require at least one "WHEN ... THEN ..." branch.');
  }
  const branches: Array<{ when: GvqlWhereClause; then: GvqlValueExpression }> = [];
  let cursor = 0;
  while (keywordAt(body, cursor, "WHEN")) {
    const thenIndex = findTopLevelCaseKeyword(body, "THEN", cursor + "WHEN".length);
    if (thenIndex < 0) throw new Error('GVQL CASE branch requires "THEN".');
    const condition = body.slice(cursor + "WHEN".length, thenIndex).trim();
    const valueStart = thenIndex + "THEN".length;
    const nextWhen = findTopLevelCaseKeyword(body, "WHEN", valueStart);
    const elseIndex = findTopLevelCaseKeyword(body, "ELSE", valueStart);
    const valueEnd = elseIndex >= 0 && (nextWhen < 0 || elseIndex < nextWhen) ? elseIndex : nextWhen >= 0 ? nextWhen : body.length;
    branches.push({ when: parseWhere(condition), then: parseValueExpression(body.slice(valueStart, valueEnd).trim()) });
    if (elseIndex >= 0 && elseIndex === valueEnd) {
      const fallback = body.slice(elseIndex + "ELSE".length).trim();
      if (!fallback) throw new Error("GVQL CASE ELSE requires a value expression.");
      return { kind: "case", branches, else: parseValueExpression(fallback) };
    }
    if (nextWhen < 0) return { kind: "case", branches };
    cursor = nextWhen;
  }
  throw new Error("Invalid GVQL CASE expression.");
}

function parseFunctionCall(input: string): GvqlValueExpression | undefined {
  const open = input.indexOf("(");
  if (open < 0 || !input.endsWith(")") || !/^[A-Za-z_][\w]*$/.test(input.slice(0, open).trim())) return undefined;
  if (!outerFunctionCall(input, open)) return undefined;
  const fn = input.slice(0, open).trim().toLowerCase();
  if (!isScalarFunction(fn)) {
    throw new Error(`Unsupported GVQL function "${fn}". Supported functions: lower, upper, trim, length, coalesce.`);
  }
  const body = input.slice(open + 1, -1).trim();
  const args = body ? splitComma(body).map(parseValueExpression) : [];
  return { kind: "function", fn, args };
}

function outerFunctionCall(input: string, open: number): boolean {
  let depth = 0;
  for (let index = open; index < input.length; index++) {
    if (isQuoted(input, index)) continue;
    const char = input[index];
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth === 0) return index === input.length - 1;
  }
  return false;
}

function isScalarFunction(value: string): value is GvqlScalarFunction {
  return value === "lower" || value === "upper" || value === "trim" || value === "length" || value === "coalesce";
}

function parseRowValueOrLiteral(input: string): GvqlLiteral | { aliasName: string } {
  if (/^[A-Za-z_][\w]*$/.test(input)) return { aliasName: input };
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

function isValueExpression(input: string): boolean {
  const trimmed = input.trim();
  return Boolean(
    findTopLevelArithmeticOperator(trimmed, ["+", "-"]) ||
      findTopLevelArithmeticOperator(trimmed, ["*", "/"]) ||
      trimmed.startsWith("$") ||
      trimmed === "null" ||
      trimmed === "true" ||
      trimmed === "false" ||
      /^-?\d+(?:\.\d+)?$/.test(trimmed) ||
      isCaseExpressionSource(trimmed) ||
      isFunctionExpressionSource(trimmed) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")),
  );
}

function isCaseExpressionSource(input: string): boolean {
  return keywordAt(input, 0, "CASE") && lastTopLevelCaseEnd(input) >= 0;
}

function isFunctionExpressionSource(input: string): boolean {
  const open = input.indexOf("(");
  return open > 0 && input.endsWith(")") && /^[A-Za-z_][\w]*$/.test(input.slice(0, open).trim()) && outerFunctionCall(input, open);
}

function isPathExpressionSource(input: string): boolean {
  return /^[A-Za-z_][\w]*(?:\.[A-Za-z_$][\w$]*)+$/.test(input.trim());
}

function lastTopLevelCaseEnd(input: string): number {
  let depth = 0;
  let nestedCases = 0;
  let last = -1;
  for (let index = "CASE".length; index < input.length; index++) {
    if (isQuoted(input, index)) continue;
    const char = input[index];
    if (char === "(" || char === "[") {
      depth++;
      continue;
    }
    if (char === ")" || char === "]") {
      depth--;
      continue;
    }
    if (depth !== 0) continue;
    if (keywordAt(input, index, "CASE")) {
      nestedCases++;
      index += "CASE".length - 1;
      continue;
    }
    if (keywordAt(input, index, "END")) {
      if (nestedCases > 0) nestedCases--;
      else last = index;
      index += "END".length - 1;
    }
  }
  return last;
}

function findTopLevelCaseKeyword(input: string, keyword: "WHEN" | "THEN" | "ELSE", start = 0): number {
  let depth = 0;
  let nestedCases = 0;
  for (let index = start; index < input.length; index++) {
    if (isQuoted(input, index)) continue;
    const char = input[index];
    if (char === "(" || char === "[") {
      depth++;
      continue;
    }
    if (char === ")" || char === "]") {
      depth--;
      continue;
    }
    if (depth !== 0) continue;
    if (keywordAt(input, index, "CASE")) {
      nestedCases++;
      index += "CASE".length - 1;
      continue;
    }
    if (keywordAt(input, index, "END") && nestedCases > 0) {
      nestedCases--;
      index += "END".length - 1;
      continue;
    }
    if (nestedCases === 0 && keywordAt(input, index, keyword)) return index;
  }
  return -1;
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

function findTopLevelColon(input: string): number {
  let depth = 0;
  for (let index = 0; index < input.length; index++) {
    if (isQuoted(input, index)) continue;
    const char = input[index];
    if (char === "[" || char === "(" || char === "{") depth++;
    if (char === "]" || char === ")" || char === "}") depth--;
    if (char === ":" && depth === 0) return index;
  }
  return -1;
}

function stripOuterParentheses(input: string): string {
  let current = input;
  while (current.startsWith("(") && current.endsWith(")") && outerParenthesesEnclose(current)) {
    current = current.slice(1, -1).trim();
  }
  return current;
}

function outerParenthesesEnclose(input: string): boolean {
  let depth = 0;
  for (let index = 0; index < input.length; index++) {
    if (isQuoted(input, index)) continue;
    const char = input[index];
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth === 0) return index === input.length - 1;
  }
  return false;
}

function findTopLevelLogicalOperator(input: string, operator: GvqlLogicalOperator): number {
  let depth = 0;
  let found = -1;
  for (let index = 0; index < input.length; index++) {
    if (isQuoted(input, index)) continue;
    const char = input[index];
    if (char === "(" || char === "[") {
      depth++;
      continue;
    }
    if (char === ")" || char === "]") {
      depth--;
      continue;
    }
    if (depth === 0 && keywordAt(input, index, operator)) {
      found = index;
      index += operator.length - 1;
    }
  }
  return found;
}

function findTopLevelArithmeticOperator(input: string, operators: Array<"+" | "-" | "*" | "/">): { index: number; operator: "+" | "-" | "*" | "/" } | undefined {
  let depth = 0;
  for (let index = input.length - 1; index >= 0; index--) {
    if (isQuoted(input, index)) continue;
    const char = input[index] as "+" | "-" | "*" | "/" | string;
    if (char === ")" || char === "]") {
      depth++;
      continue;
    }
    if (char === "(" || char === "[") {
      depth--;
      continue;
    }
    if (depth !== 0 || !operators.includes(char as "+" | "-" | "*" | "/")) continue;
    if ((char === "+" || char === "-") && isUnarySign(input, index)) continue;
    return { index, operator: char as "+" | "-" | "*" | "/" };
  }
  return undefined;
}

function isUnarySign(input: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(input[cursor] ?? "")) cursor--;
  if (cursor < 0) return true;
  return /[([+\-*/]/.test(input[cursor] ?? "");
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
