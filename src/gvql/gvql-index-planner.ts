import { evaluateGvqlValueExpression } from "./gvql-expressions.js";
import { stableIndexValueKey, textLookupTerms, tokenizeIndexText, tupleIndexKey } from "./gvql-index-keys.js";
import type {
  GvqlBinding,
  GvqlGraphIndex,
  GvqlMatchPattern,
  GvqlPathExpression,
  GvqlPredicate,
  GvqlStatement,
  GvqlValueExpression,
} from "./gvql-types.js";

export interface PlannedIndexSelection {
  path: string;
  source: "composite-index" | "range-index" | "text-index" | "fulltext-index" | "expression-index" | "unique-index";
  objectIds: string[];
  propertyIndexes: Array<{ path: string; key: string; value: unknown; candidates: number }>;
  operation: string;
}

export function advancedIndexSelections(index: GvqlGraphIndex, statement: GvqlStatement, pattern: GvqlMatchPattern, parameters: Record<string, unknown>): PlannedIndexSelection[] {
  if (!index.advanced || !statement.where) return [];
  const predicates = flattenAndPredicates(statement.where);
  if (!predicates?.length) return [];
  const start = pattern.start;
  const equality = equalityPredicates(predicates, start.alias, parameters);
  const selections: PlannedIndexSelection[] = [];
  selections.push(...uniqueSelections(index, start.type, equality));
  selections.push(...compositeSelections(index, start.type, equality));
  selections.push(...expressionSelections(index, predicates, start.alias, start.type, parameters));
  selections.push(...rangeSelections(index, predicates, start.alias, start.type, parameters));
  selections.push(...textSelections(index, predicates, start.alias, start.type, parameters));
  selections.push(...fullTextSelections(index, predicates, start.alias, start.type, parameters));
  return selections.sort((left, right) => left.objectIds.length - right.objectIds.length);
}

function uniqueSelections(index: GvqlGraphIndex, type: string | undefined, equality: Map<string, unknown>): PlannedIndexSelection[] {
  const advanced = index.advanced;
  if (!advanced) return [];
  return advanced.definitions
    .filter((definition) => definition.kind === "unique" && typeMatches(definition.type, type))
    .flatMap((definition) => {
      const paths = definition.paths ?? (definition.path ? [definition.path] : []);
      if (!paths.length || paths.some((path) => !equality.has(path))) return [];
      const key = tupleIndexKey(paths.map((path) => equality.get(path)));
      const objectId = advanced.unique.get(definition.name)?.get(key);
      const ids = objectId ? [objectId] : [];
      return [selection(definition.name, paths.join("+"), "unique-index", key, ids)];
    });
}

function compositeSelections(index: GvqlGraphIndex, type: string | undefined, equality: Map<string, unknown>): PlannedIndexSelection[] {
  const advanced = index.advanced;
  if (!advanced) return [];
  return advanced.definitions
    .filter((definition) => definition.kind === "composite" && typeMatches(definition.type, type))
    .flatMap((definition) => {
      const paths = definition.paths ?? [];
      if (paths.length < 2 || paths.some((path) => !equality.has(path))) return [];
      const key = tupleIndexKey(paths.map((path) => equality.get(path)));
      const ids = advanced.composite.get(definition.name)?.get(key) ?? [];
      return [selection(definition.name, paths.join("+"), "composite-index", key, ids)];
    });
}

function expressionSelections(index: GvqlGraphIndex, predicates: GvqlPredicate[], alias: string, type: string | undefined, parameters: Record<string, unknown>): PlannedIndexSelection[] {
  const advanced = index.advanced;
  if (!advanced) return [];
  const result: PlannedIndexSelection[] = [];
  for (const predicate of predicates) {
    if (predicate.operator !== "=") continue;
    const target = expressionTarget(predicate.left, alias);
    const value = constantValue(predicate.right, parameters);
    if (!target || !value.ok) continue;
    for (const definition of advanced.definitions) {
      if (definition.kind !== "expression" || !definition.expression || !typeMatches(definition.type, type)) continue;
      if (definition.expression.fn !== target.fn || definition.expression.path !== target.path) continue;
      const key = stableIndexValueKey(value.value);
      const ids = advanced.expression.get(definition.name)?.get(key) ?? [];
      result.push(selection(definition.name, `${target.fn}(${target.path})`, "expression-index", key, ids));
    }
  }
  return result;
}

function rangeSelections(index: GvqlGraphIndex, predicates: GvqlPredicate[], alias: string, type: string | undefined, parameters: Record<string, unknown>): PlannedIndexSelection[] {
  const advanced = index.advanced;
  if (!advanced) return [];
  const operators = new Set([">", ">=", "<", "<="]);
  const result: PlannedIndexSelection[] = [];
  for (const predicate of predicates) {
    if (!operators.has(predicate.operator) || !isPath(predicate.left) || predicate.left.alias !== alias || !predicate.left.path) continue;
    const value = constantValue(predicate.right, parameters);
    if (!value.ok) continue;
    for (const definition of advanced.definitions) {
      if (definition.kind !== "range" || definition.path !== predicate.left.path || !typeMatches(definition.type, type)) continue;
      const ids = rangeLookup(advanced.range.get(definition.name) ?? [], predicate.operator, value.value);
      result.push(selection(definition.name, definition.path, "range-index", `${predicate.operator}:${stableIndexValueKey(value.value)}`, ids));
    }
  }
  return result;
}

function textSelections(index: GvqlGraphIndex, predicates: GvqlPredicate[], alias: string, type: string | undefined, parameters: Record<string, unknown>): PlannedIndexSelection[] {
  const advanced = index.advanced;
  if (!advanced) return [];
  const result: PlannedIndexSelection[] = [];
  for (const predicate of predicates) {
    if (!["CONTAINS", "STARTS WITH", "ENDS WITH"].includes(predicate.operator) || !isPath(predicate.left) || predicate.left.alias !== alias || !predicate.left.path) continue;
    const value = constantValue(predicate.right, parameters);
    if (!value.ok) continue;
    for (const definition of advanced.definitions) {
      if (definition.kind !== "text" || definition.path !== predicate.left.path || !typeMatches(definition.type, type)) continue;
      const terms = textLookupTerms(predicate.operator as "CONTAINS" | "STARTS WITH" | "ENDS WITH", value.value, definition);
      if (!terms.length) continue;
      const ids = intersectTermBuckets(terms.map((term) => advanced.text.get(definition.name)?.get(term) ?? []));
      result.push(selection(definition.name, definition.path, "text-index", terms.join(","), ids));
    }
  }
  return result;
}

function fullTextSelections(index: GvqlGraphIndex, predicates: GvqlPredicate[], alias: string, type: string | undefined, parameters: Record<string, unknown>): PlannedIndexSelection[] {
  const advanced = index.advanced;
  if (!advanced) return [];
  const result: PlannedIndexSelection[] = [];
  for (const predicate of predicates) {
    if (predicate.operator !== "CONTAINS" || !isPath(predicate.left) || predicate.left.alias !== alias || !predicate.left.path) continue;
    const value = constantValue(predicate.right, parameters);
    if (!value.ok) continue;
    for (const definition of advanced.definitions) {
      if (definition.kind !== "fullText" || definition.path !== predicate.left.path || !typeMatches(definition.type, type)) continue;
      const terms = tokenizeIndexText(value.value, definition.caseSensitive);
      if (!terms.length) continue;
      const ids = intersectTermBuckets(terms.map((term) => advanced.fullText.get(definition.name)?.get(term) ?? []));
      result.push(selection(definition.name, definition.path, "fulltext-index", terms.join(","), ids));
    }
  }
  return result;
}

function equalityPredicates(predicates: GvqlPredicate[], alias: string, parameters: Record<string, unknown>): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const predicate of predicates) {
    if (predicate.operator !== "=" || !isPath(predicate.left) || predicate.left.alias !== alias || !predicate.left.path) continue;
    const value = constantValue(predicate.right, parameters);
    if (value.ok) result.set(predicate.left.path, value.value);
  }
  return result;
}

function constantValue(expression: GvqlValueExpression, parameters: Record<string, unknown>): { ok: true; value: unknown } | { ok: false } {
  if (containsPath(expression)) return { ok: false };
  const value = evaluateGvqlValueExpression({} as GvqlGraphIndex, {} as GvqlBinding, expression, parameters, () => undefined);
  return { ok: true, value };
}

function expressionTarget(expression: GvqlValueExpression, alias: string): { fn: "lower" | "upper" | "trim" | "length"; path: string } | undefined {
  if (!expression || typeof expression !== "object" || !("kind" in expression) || expression.kind !== "function") return undefined;
  if (!["lower", "upper", "trim", "length"].includes(expression.fn) || expression.args.length !== 1) return undefined;
  const arg = expression.args[0];
  return isPath(arg) && arg.alias === alias && arg.path ? { fn: expression.fn as "lower" | "upper" | "trim" | "length", path: arg.path } : undefined;
}

function containsPath(expression: GvqlValueExpression): boolean {
  if (isPath(expression)) return true;
  if (!expression || typeof expression !== "object" || !("kind" in expression)) return false;
  if (expression.kind === "function") return expression.args.some(containsPath);
  if (expression.kind === "binary") return containsPath(expression.left) || containsPath(expression.right);
  if (expression.kind === "case") return true;
  return false;
}

function rangeLookup(entries: Array<{ raw: unknown; objectIds: string[] }>, operator: string, value: unknown): string[] {
  return union(entries.filter((entry) => compare(entry.raw, value, operator)).map((entry) => entry.objectIds));
}

function compare(left: unknown, right: unknown, operator: string): boolean {
  const comparison = typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""));
  if (operator === ">") return comparison > 0;
  if (operator === ">=") return comparison >= 0;
  if (operator === "<") return comparison < 0;
  return comparison <= 0;
}

function selection(name: string, path: string, source: PlannedIndexSelection["source"], key: string, objectIds: string[]): PlannedIndexSelection {
  return {
    path,
    source,
    objectIds: [...objectIds],
    propertyIndexes: [{ path, key, value: key, candidates: objectIds.length }],
    operation: `${source}:${name}`,
  };
}

function flattenAndPredicates(expression: GvqlStatement["where"]): GvqlPredicate[] | undefined {
  if (!expression) return undefined;
  if (expression.kind === "predicate") return [expression.predicate];
  if (expression.kind === "not" || expression.operator !== "AND") return undefined;
  const left = flattenAndPredicates(expression.left);
  const right = flattenAndPredicates(expression.right);
  return left && right ? [...left, ...right] : undefined;
}

function intersectTermBuckets(lists: string[][]): string[] {
  if (lists.length === 0) return [];
  const [first = [], ...rest] = lists;
  const result = new Set(first);
  for (const list of rest) {
    const allowed = new Set(list);
    for (const item of result) if (!allowed.has(item)) result.delete(item);
  }
  return [...result];
}

function union(lists: string[][]): string[] {
  return [...new Set(lists.flat())];
}

function typeMatches(definitionType: string | undefined, queryType: string | undefined): boolean {
  return !definitionType || !queryType || definitionType === queryType;
}

function isPath(value: unknown): value is GvqlPathExpression {
  return Boolean(value && typeof value === "object" && "alias" in value);
}
