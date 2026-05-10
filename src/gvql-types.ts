import type { EncodedValue, SerializedEnvelope, StoreMetadata } from "./types.js";

export type GvqlStatementKind = "select" | "update";
export type GvqlDirection = "out" | "in";
export type GvqlCompareOperator =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "CONTAINS"
  | "STARTS WITH"
  | "ENDS WITH"
  | "IN"
  | "IS NULL"
  | "IS NOT NULL";
export type GvqlLogicalOperator = "AND" | "OR";
export type GvqlArithmeticOperator = "+" | "-" | "*" | "/";
export type GvqlAggregateFunction = "count" | "sum" | "avg" | "min" | "max";
export type GvqlScalarFunction = "lower" | "upper" | "trim" | "length" | "coalesce";

export interface GvqlNodePattern {
  alias: string;
  type?: string;
}

export interface GvqlEdgePattern {
  direction: GvqlDirection;
  label?: string;
}

export interface GvqlMatchPattern {
  start: GvqlNodePattern;
  chain: Array<{ edge: GvqlEdgePattern; node: GvqlNodePattern }>;
}

export interface GvqlPathExpression {
  alias: string;
  path?: string;
}

export type GvqlLiteral =
  | null
  | string
  | number
  | boolean
  | { parameter: string }
  | GvqlLiteral[];

export interface GvqlPredicate {
  left: GvqlValueExpression;
  operator: GvqlCompareOperator;
  right: GvqlValueExpression;
}

export type GvqlBooleanExpression<TPredicate> =
  | { kind: "predicate"; predicate: TPredicate }
  | { kind: "not"; expression: GvqlBooleanExpression<TPredicate> }
  | { kind: "logical"; operator: GvqlLogicalOperator; left: GvqlBooleanExpression<TPredicate>; right: GvqlBooleanExpression<TPredicate> };

export type GvqlWhereClause = GvqlBooleanExpression<GvqlPredicate>;

export interface GvqlRowReference {
  aliasName: string;
}

export interface GvqlRowPredicate {
  left: GvqlRowReference;
  operator: GvqlCompareOperator;
  right: GvqlLiteral | GvqlRowReference;
}

export type GvqlHavingClause = GvqlBooleanExpression<GvqlRowPredicate>;

export type GvqlReturnExpression =
  | { kind: "all"; alias?: string; aliasName?: string }
  | { kind: "path"; expression: GvqlPathExpression; aliasName?: string }
  | { kind: "row"; source: string; aliasName?: string }
  | { kind: "value"; expression: GvqlValueExpression; source: string; aliasName?: string }
  | { kind: "count"; expression?: GvqlPathExpression; distinct?: boolean; aliasName?: string }
  | { kind: "aggregate"; fn: Exclude<GvqlAggregateFunction, "count">; expression: GvqlPathExpression; aliasName?: string };

export type GvqlValueExpression =
  | GvqlLiteral
  | GvqlPathExpression
  | { kind: "binary"; operator: GvqlArithmeticOperator; left: GvqlValueExpression; right: GvqlValueExpression }
  | { kind: "function"; fn: GvqlScalarFunction; args: GvqlValueExpression[] }
  | { kind: "case"; branches: Array<{ when: GvqlWhereClause; then: GvqlValueExpression }>; else?: GvqlValueExpression };

export type GvqlSetValueExpression = GvqlValueExpression;

export interface GvqlSetExpression {
  target: GvqlPathExpression;
  value: GvqlSetValueExpression;
}

export interface GvqlRemoveExpression {
  target: GvqlPathExpression;
}

export interface GvqlDeleteExpression {
  alias: string;
}

export interface GvqlCreateExpression {
  alias: string;
  type?: string;
  props: Record<string, GvqlValueExpression>;
  into: GvqlPathExpression;
}

export type GvqlOrderExpression =
  | { kind: "path"; expression: GvqlPathExpression }
  | { kind: "alias"; aliasName: string };

export interface GvqlOrderBy {
  expression: GvqlOrderExpression;
  direction: "asc" | "desc";
}

export interface GvqlWithClause {
  returns: GvqlReturnExpression[];
  distinct: boolean;
  where?: GvqlHavingClause;
}

export interface GvqlStatement {
  kind: GvqlStatementKind;
  match: GvqlMatchPattern;
  matches: GvqlMatchPattern[];
  optionalMatches: GvqlMatchPattern[];
  where?: GvqlWhereClause;
  with?: GvqlWithClause;
  returns: GvqlReturnExpression[];
  distinct: boolean;
  set: GvqlSetExpression[];
  remove: GvqlRemoveExpression[];
  delete: GvqlDeleteExpression[];
  create: GvqlCreateExpression[];
  orderBy?: GvqlOrderBy[];
  groupBy?: GvqlPathExpression[];
  having?: GvqlHavingClause;
  limit?: number;
  offset?: number;
}

export interface GvqlGraphNode {
  objectId: string;
  kind: string;
  type?: string;
}

export interface GvqlGraphEdge {
  from: string;
  to: string;
  path: string;
  label: string;
}

export interface GvqlGraphIndex {
  envelope: SerializedEnvelope;
  nodes: Map<string, GvqlGraphNode>;
  byType: Map<string, string[]>;
  byProperty: Map<string, string[]>;
  outgoing: Map<string, GvqlGraphEdge[]>;
  incoming: Map<string, GvqlGraphEdge[]>;
}

export interface GvqlExecutionOptions {
  parameters?: Record<string, unknown>;
  allowMutations?: boolean;
  dryRun?: boolean;
}

export type GvqlCandidateSource = "property-index" | "type-index" | "id-index" | "full-scan";

export interface GvqlExecutionPlan {
  nodeCount: number;
  candidateSource: GvqlCandidateSource;
  indexUsed: boolean;
  startType?: string;
  propertyIndex?: {
    path: string;
    key: string;
    value: unknown;
  };
  propertyIndexes?: Array<{
    path: string;
    key: string;
    value: unknown;
    candidates: number;
  }>;
  startCandidates: number;
  edgeSteps: number;
  matchedBindings: number;
  filteredBindings: number;
  returnedRows: number;
  limit?: number;
  offset: number;
  distinct: boolean;
  grouped: boolean;
  having: boolean;
  operations: string[];
}

export interface GvqlQueryResult {
  kind: "select";
  statement: GvqlStatement;
  rows: Array<Record<string, unknown>>;
  matched: number;
  scannedObjects: number;
  elapsedMs: number;
  plan: GvqlExecutionPlan;
}

export interface GvqlMutationPreview {
  objectId: string;
  alias: string;
  path: string;
  before: unknown;
  after: unknown;
  operation?: "set" | "remove" | "detach" | "delete" | "create" | "attach";
}

export interface GvqlMutationResult {
  kind: "update";
  statement: GvqlStatement;
  rows: Array<Record<string, unknown>>;
  matched: number;
  changed: number;
  scannedObjects: number;
  elapsedMs: number;
  dryRun: boolean;
  changes: GvqlMutationPreview[];
  plan: GvqlExecutionPlan;
  metadata?: StoreMetadata;
}

export type GvqlResult = GvqlQueryResult | GvqlMutationResult;

export type GvqlBinding = Record<string, string>;

export interface GvqlExecutableContext {
  envelope: SerializedEnvelope;
  transactionId?: number;
}

export type GvqlEncodedSetter = (objectId: string, path: string, value: EncodedValue) => void;
