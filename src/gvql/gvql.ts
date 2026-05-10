export { executeGvqlStatement, matchBindings } from "./gvql-executor.js";
export { buildGvqlGraphIndex, propertyIndexKey, referencedEdges, visitEncodedNode } from "./gvql-index.js";
export { parseGvql } from "./gvql-parser.js";
export { encodedValueToJs, jsValueToEncoded } from "./gvql-values.js";
export type {
  GvqlAggregateFunction,
  GvqlArithmeticOperator,
  GvqlBinding,
  GvqlCompareOperator,
  GvqlDirection,
  GvqlEdgePattern,
  GvqlExecutableContext,
  GvqlExecutionOptions,
  GvqlGraphEdge,
  GvqlGraphIndex,
  GvqlGraphNode,
  GvqlLiteral,
  GvqlLogicalOperator,
  GvqlMatchPattern,
  GvqlMutationPreview,
  GvqlMutationResult,
  GvqlNodePattern,
  GvqlOrderBy,
  GvqlPathExpression,
  GvqlPredicate,
  GvqlQueryResult,
  GvqlResult,
  GvqlReturnExpression,
  GvqlSetExpression,
  GvqlSetValueExpression,
  GvqlStatement,
  GvqlStatementKind,
  GvqlWhereClause,
} from "./gvql-types.js";
