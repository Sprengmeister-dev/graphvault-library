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
  return isPathExpression(expression) ? readPath(index, binding, expression) : literalToJs(expression, parameters);
}

function isPathExpression(value: unknown): value is GvqlPathExpression {
  return Boolean(value && typeof value === "object" && "alias" in value);
}

function isBinaryValueExpression(value: unknown): value is Extract<GvqlValueExpression, { kind: "binary" }> {
  return Boolean(value && typeof value === "object" && "kind" in value && value.kind === "binary");
}
