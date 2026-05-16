import { evaluateGvqlValueExpression } from "./gvql-expressions.js";
import type { GvqlBinding, GvqlGraphIndex, GvqlReturnExpression, GvqlStatement } from "./gvql-types.js";

export type GvqlPathReader = (index: GvqlGraphIndex, binding: GvqlBinding, expression: { alias: string; path?: string }) => unknown;
export type GvqlNodeReader = (index: GvqlGraphIndex, objectId: string | undefined) => unknown;

/** Runs the public projectGvqlRows helper. */
export function projectGvqlRows(
  index: GvqlGraphIndex,
  bindings: GvqlBinding[],
  statement: GvqlStatement,
  readPath: GvqlPathReader,
  readNode: GvqlNodeReader,
  parameters: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  if (statement.groupBy?.length || statement.returns.some((item) => item.kind === "aggregate" || item.kind === "count")) {
    return projectAggregateRows(index, bindings, statement, readPath, parameters);
  }
  return bindings.map((binding) => projectPlainRow(index, binding, statement.returns, readPath, readNode, parameters));
}

function projectPlainRow(
  index: GvqlGraphIndex,
  binding: GvqlBinding,
  returns: GvqlReturnExpression[],
  readPath: GvqlPathReader,
  readNode: GvqlNodeReader,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const item of returns) {
    if (item.kind === "all") {
      if (item.alias) row[item.aliasName ?? item.alias] = readNode(index, binding[item.alias]);
      else row[item.aliasName ?? "*"] = Object.fromEntries(Object.entries(binding).map(([alias, objectId]) => [alias, readNode(index, objectId)]));
    } else if (item.kind === "path") {
      row[item.aliasName ?? [item.expression.alias, item.expression.path].filter(Boolean).join(".")] = readPath(index, binding, item.expression);
    } else if (item.kind === "value") {
      row[item.aliasName ?? item.source] = evaluateGvqlValueExpression(index, binding, item.expression, parameters, readPath);
    }
  }
  return row;
}

function projectAggregateRows(
  index: GvqlGraphIndex,
  bindings: GvqlBinding[],
  statement: GvqlStatement,
  readPath: GvqlPathReader,
  parameters: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const groupBy = statement.groupBy ?? [];
  const groups = new Map<string, GvqlBinding[]>();
  for (const binding of bindings) {
    const keyValues = groupBy.map((expression) => readPath(index, binding, expression));
    const key = JSON.stringify(keyValues);
    const group = groups.get(key) ?? [];
    group.push(binding);
    groups.set(key, group);
  }
  if (groups.size === 0 && groupBy.length === 0) {
    groups.set("[]", []);
  }
  return Array.from(groups.values()).map((group) => {
    const row: Record<string, unknown> = {};
    for (const item of statement.returns) {
      if (item.kind === "count") {
        row[item.aliasName ?? "count"] = item.expression ? countValues(group, index, item.expression, item.distinct ?? false, readPath) : group.length;
      } else if (item.kind === "aggregate") {
        row[item.aliasName ?? `${item.fn}.${item.expression.alias}.${item.expression.path ?? ""}`] = aggregate(
          item.fn,
          group.map((binding) => readPath(index, binding, item.expression)),
        );
      } else if (item.kind === "path") {
        row[item.aliasName ?? [item.expression.alias, item.expression.path].filter(Boolean).join(".")] = group[0]
          ? readPath(index, group[0], item.expression)
          : undefined;
      } else if (item.kind === "value") {
        row[item.aliasName ?? item.source] = group[0]
          ? evaluateGvqlValueExpression(index, group[0], item.expression, parameters, readPath)
          : undefined;
      }
    }
    return row;
  });
}

function countValues(
  group: GvqlBinding[],
  index: GvqlGraphIndex,
  expression: { alias: string; path?: string },
  distinct: boolean,
  readPath: GvqlPathReader,
): number {
  const values = group
    .map((binding) => readPath(index, binding, expression))
    .filter((value) => value !== null && typeof value !== "undefined");
  if (!distinct) return values.length;
  return new Set(values.map(stableStringify)).size;
}

function aggregate(fn: "sum" | "avg" | "min" | "max", values: unknown[]): unknown {
  const present = values.filter((value) => value !== null && typeof value !== "undefined");
  if (fn === "sum" || fn === "avg") {
    const numbers = present.map(Number).filter(Number.isFinite);
    const sum = numbers.reduce((total, value) => total + value, 0);
    return fn === "sum" ? sum : numbers.length ? sum / numbers.length : null;
  }
  const sorted = [...present].sort((a, b) => compare(a, b));
  return fn === "min" ? sorted[0] ?? null : sorted[sorted.length - 1] ?? null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""));
}
