import { literalToJs } from "./gvql-values.js";
import type { GvqlBinding, GvqlBooleanExpression, GvqlGraphIndex, GvqlPathExpression, GvqlPredicate, GvqlValueExpression, GvqlWhereClause } from "./gvql-types.js";

export type GvqlPathReader = (index: GvqlGraphIndex, binding: GvqlBinding, expression: GvqlPathExpression) => unknown;

/** Evaluates a GVQL value expression against one row binding. */
export function evaluateGvqlValueExpression(
  index: GvqlGraphIndex,
  binding: GvqlBinding,
  expression: GvqlValueExpression,
  parameters: Record<string, unknown>,
  readPath: GvqlPathReader,
): unknown {
  if (isCaseValueExpression(expression)) {
    for (const branch of expression.branches) {
      if (evaluateGvqlWhereExpression(index, binding, branch.when, parameters, readPath)) {
        return evaluateGvqlValueExpression(index, binding, branch.then, parameters, readPath);
      }
    }
    return expression.else ? evaluateGvqlValueExpression(index, binding, expression.else, parameters, readPath) : null;
  }
  if (isBinaryValueExpression(expression)) {
    const left = evaluateGvqlValueExpression(index, binding, expression.left, parameters, readPath);
    const right = evaluateGvqlValueExpression(index, binding, expression.right, parameters, readPath);
    if (typeof left !== "number" || typeof right !== "number") {
      throw new Error("GVQL arithmetic expressions require numeric operands.");
    }
    switch (expression.operator) {
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "*":
        return left * right;
      case "/":
        return left / right;
    }
  }
  if (isFunctionValueExpression(expression)) {
    const args = expression.args.map((arg) => evaluateGvqlValueExpression(index, binding, arg, parameters, readPath));
    return evaluateScalarFunction(expression.fn, args);
  }
  return isPathExpression(expression) ? readPath(index, binding, expression) : literalToJs(expression, parameters);
}

/** Evaluates an optional GVQL WHERE predicate, treating a missing predicate as true. */
export function evaluateGvqlWhereExpression(
  index: GvqlGraphIndex,
  binding: GvqlBinding,
  expression: GvqlWhereClause,
  parameters: Record<string, unknown>,
  readPath: GvqlPathReader,
): boolean {
  return evaluateGvqlBooleanExpression(expression, (predicate) => evaluatePredicate(index, binding, predicate, parameters, readPath));
}

/** Evaluates a GVQL boolean expression against one row binding. */
export function evaluateGvqlBooleanExpression<TPredicate>(
  expression: GvqlBooleanExpression<TPredicate>,
  evaluate: (predicate: TPredicate) => boolean,
): boolean {
  if (expression.kind === "predicate") return evaluate(expression.predicate);
  if (expression.kind === "not") return !evaluateGvqlBooleanExpression(expression.expression, evaluate);
  if (expression.operator === "AND") return evaluateGvqlBooleanExpression(expression.left, evaluate) && evaluateGvqlBooleanExpression(expression.right, evaluate);
  return evaluateGvqlBooleanExpression(expression.left, evaluate) || evaluateGvqlBooleanExpression(expression.right, evaluate);
}

function evaluatePredicate(
  index: GvqlGraphIndex,
  binding: GvqlBinding,
  predicate: GvqlPredicate,
  parameters: Record<string, unknown>,
  readPath: GvqlPathReader,
): boolean {
  const left = evaluateGvqlValueExpression(index, binding, predicate.left, parameters, readPath);
  const right = evaluateGvqlValueExpression(index, binding, predicate.right, parameters, readPath);
  switch (predicate.operator) {
    case "=":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return compare(left, right) > 0;
    case ">=":
      return compare(left, right) >= 0;
    case "<":
      return compare(left, right) < 0;
    case "<=":
      return compare(left, right) <= 0;
    case "CONTAINS":
      return String(left ?? "").includes(String(right ?? ""));
    case "STARTS WITH":
      return String(left ?? "").startsWith(String(right ?? ""));
    case "ENDS WITH":
      return String(left ?? "").endsWith(String(right ?? ""));
    case "IN":
      return Array.isArray(right) && right.includes(left);
    case "IS NULL":
      return left === null || typeof left === "undefined";
    case "IS NOT NULL":
      return left !== null && typeof left !== "undefined";
  }
  return false;
}

function evaluateScalarFunction(fn: "lower" | "upper" | "trim" | "length" | "coalesce", args: unknown[]): unknown {
  if (fn === "coalesce") {
    if (args.length === 0) throw new Error("GVQL coalesce() requires at least one argument.");
    return args.find((value) => value !== null && typeof value !== "undefined");
  }
  if (args.length !== 1) throw new Error(`GVQL ${fn}() expects exactly one argument.`);
  const [value] = args;
  if (value === null || typeof value === "undefined") return null;
  if (fn === "length") {
    if (typeof value === "string" || Array.isArray(value)) return value.length;
    if (value instanceof Map || value instanceof Set) return value.size;
    return String(value).length;
  }
  const text = String(value);
  if (fn === "lower") return text.toLowerCase();
  if (fn === "upper") return text.toUpperCase();
  return text.trim();
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function isPathExpression(value: unknown): value is GvqlPathExpression {
  return Boolean(value && typeof value === "object" && "alias" in value);
}

function isCaseValueExpression(value: unknown): value is Extract<GvqlValueExpression, { kind: "case" }> {
  return Boolean(value && typeof value === "object" && "kind" in value && value.kind === "case");
}

function isBinaryValueExpression(value: unknown): value is Extract<GvqlValueExpression, { kind: "binary" }> {
  return Boolean(value && typeof value === "object" && "kind" in value && value.kind === "binary");
}

function isFunctionValueExpression(value: unknown): value is Extract<GvqlValueExpression, { kind: "function" }> {
  return Boolean(value && typeof value === "object" && "kind" in value && value.kind === "function");
}
