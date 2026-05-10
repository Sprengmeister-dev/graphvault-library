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
export type GvqlAggregateFunction = "count" | "sum" | "avg" | "min" | "max";

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
  left: GvqlPathExpression;
  operator: GvqlCompareOperator;
  right: GvqlLiteral | GvqlPathExpression;
}

export interface GvqlWhereClause {
  first: GvqlPredicate;
  rest: Array<{ operator: GvqlLogicalOperator; predicate: GvqlPredicate }>;
}

export interface GvqlRowReference {
  aliasName: string;
}

export interface GvqlRowPredicate {
  left: GvqlRowReference;
  operator: GvqlCompareOperator;
  right: GvqlLiteral | GvqlRowReference;
}

export interface GvqlHavingClause {
  first: GvqlRowPredicate;
  rest: Array<{ operator: GvqlLogicalOperator; predicate: GvqlRowPredicate }>;
}

export type GvqlReturnExpression =
  | { kind: "all"; alias?: string; aliasName?: string }
  | { kind: "path"; expression: GvqlPathExpression; aliasName?: string }
  | { kind: "count"; expression?: GvqlPathExpression; aliasName?: string }
  | { kind: "aggregate"; fn: Exclude<GvqlAggregateFunction, "count">; expression: GvqlPathExpression; aliasName?: string };

export interface GvqlSetExpression {
  target: GvqlPathExpression;
  value: GvqlLiteral | GvqlPathExpression;
}

export interface GvqlRemoveExpression {
  target: GvqlPathExpression;
}

export type GvqlOrderExpression =
  | { kind: "path"; expression: GvqlPathExpression }
  | { kind: "alias"; aliasName: string };

export interface GvqlOrderBy {
  expression: GvqlOrderExpression;
  direction: "asc" | "desc";
}

export interface GvqlStatement {
  kind: GvqlStatementKind;
  match: GvqlMatchPattern;
  where?: GvqlWhereClause;
  returns: GvqlReturnExpression[];
  distinct: boolean;
  set: GvqlSetExpression[];
  remove: GvqlRemoveExpression[];
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

export type GvqlCandidateSource = "property-index" | "type-index" | "full-scan";

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
