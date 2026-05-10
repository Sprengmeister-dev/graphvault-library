import { literalToJs } from "./gvql-values.js";
import type { GvqlBinding, GvqlGraphIndex, GvqlPathExpression, GvqlValueExpression } from "./gvql-types.js";

export type GvqlPathReader = (index: GvqlGraphIndex, binding: GvqlBinding, expression: GvqlPathExpression) => unknown;

export function evaluateGvqlValueExpression(
  index: GvqlGraphIndex,
  binding: GvqlBinding,
  expression: GvqlValueExpression,
  parameters: Record<string, unknown>,
  readPath: GvqlPathReader,
): unknown {
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

function isPathExpression(value: unknown): value is GvqlPathExpression {
  return Boolean(value && typeof value === "object" && "alias" in value);
}

function isBinaryValueExpression(value: unknown): value is Extract<GvqlValueExpression, { kind: "binary" }> {
  return Boolean(value && typeof value === "object" && "kind" in value && value.kind === "binary");
}

function isFunctionValueExpression(value: unknown): value is Extract<GvqlValueExpression, { kind: "function" }> {
  return Boolean(value && typeof value === "object" && "kind" in value && value.kind === "function");
}
