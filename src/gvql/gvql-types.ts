import type { EncodedValue, SerializedEnvelope, StorageAdvancedIndexRecord, StoreMetadata } from "../core/types.js";

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

/** Describes the public GvqlNodePattern contract. */
export interface GvqlNodePattern {
  alias: string;
  type?: string;
}

/** Describes the public GvqlEdgePattern contract. */
export interface GvqlEdgePattern {
  direction: GvqlDirection;
  label?: string;
}

/** Describes the public GvqlMatchPattern contract. */
export interface GvqlMatchPattern {
  start: GvqlNodePattern;
  chain: Array<{ edge: GvqlEdgePattern; node: GvqlNodePattern }>;
}

/** Describes the public GvqlPathExpression contract. */
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

/** Describes the public GvqlPredicate contract. */
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

/** Describes the public GvqlRowReference contract. */
export interface GvqlRowReference {
  aliasName: string;
}

/** Describes the public GvqlRowPredicate contract. */
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

/** Describes the public GvqlSetExpression contract. */
export interface GvqlSetExpression {
  target: GvqlPathExpression;
  value: GvqlSetValueExpression;
}

/** Describes the public GvqlRemoveExpression contract. */
export interface GvqlRemoveExpression {
  target: GvqlPathExpression;
}

/** Describes the public GvqlDeleteExpression contract. */
export interface GvqlDeleteExpression {
  alias: string;
}

/** Describes the public GvqlCreateExpression contract. */
export interface GvqlCreateExpression {
  alias: string;
  type?: string;
  props: Record<string, GvqlValueExpression>;
  into: GvqlPathExpression;
}

/** Describes the public GvqlMergeExpression contract. */
export interface GvqlMergeExpression extends GvqlCreateExpression {
  on: GvqlPathExpression;
}

export type GvqlOrderExpression =
  | { kind: "path"; expression: GvqlPathExpression }
  | { kind: "alias"; aliasName: string };

/** Describes the public GvqlOrderBy contract. */
export interface GvqlOrderBy {
  expression: GvqlOrderExpression;
  direction: "asc" | "desc";
}

/** Describes the public GvqlWithClause contract. */
export interface GvqlWithClause {
  returns: GvqlReturnExpression[];
  distinct: boolean;
  where?: GvqlHavingClause;
}

/** Describes the public GvqlStatement contract. */
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
  merge: GvqlMergeExpression[];
  orderBy?: GvqlOrderBy[];
  groupBy?: GvqlPathExpression[];
  having?: GvqlHavingClause;
  limit?: number;
  offset?: number;
}

/** Describes the public GvqlGraphNode contract. */
export interface GvqlGraphNode {
  objectId: string;
  kind: string;
  type?: string;
}

/** Describes the public GvqlGraphEdge contract. */
export interface GvqlGraphEdge {
  from: string;
  to: string;
  path: string;
  label: string;
}

/** Describes the public GvqlGraphIndex contract. */
export interface GvqlGraphIndex {
  envelope: SerializedEnvelope;
  nodes: Map<string, GvqlGraphNode>;
  byType: Map<string, string[]>;
  byProperty: Map<string, string[]>;
  outgoing: Map<string, GvqlGraphEdge[]>;
  incoming: Map<string, GvqlGraphEdge[]>;
  advanced?: GvqlAdvancedGraphIndex;
  propertyIndexMode?: "all" | "configured";
  indexedPropertyKeys?: Set<string>;
  source?: "ephemeral" | "persistent";
  transactionId?: number;
}

/** Describes the public GvqlAdvancedGraphIndex contract. */
export interface GvqlAdvancedGraphIndex {
  definitions: StorageAdvancedIndexRecord["definitions"];
  composite: Map<string, Map<string, string[]>>;
  range: Map<string, Array<{ value: string; raw: unknown; objectIds: string[] }>>;
  text: Map<string, Map<string, string[]>>;
  fullText: Map<string, Map<string, string[]>>;
  expression: Map<string, Map<string, string[]>>;
  unique: Map<string, Map<string, string>>;
  statistics: StorageAdvancedIndexRecord["statistics"];
}

/** Describes the public GvqlExecutionOptions contract. */
export interface GvqlExecutionOptions {
  parameters?: Record<string, unknown>;
  allowMutations?: boolean;
  dryRun?: boolean;
  graphIndex?: GvqlGraphIndex;
}

export type GvqlCandidateSource = "property-index" | "composite-index" | "range-index" | "text-index" | "fulltext-index" | "expression-index" | "unique-index" | "type-index" | "id-index" | "full-scan";

/** Describes the public GvqlExecutionPlan contract. */
export interface GvqlExecutionPlan {
  nodeCount: number;
  candidateSource: GvqlCandidateSource;
  indexUsed: boolean;
  indexSource: "ephemeral" | "persistent";
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

/** Describes the public GvqlQueryResult contract. */
export interface GvqlQueryResult {
  kind: "select";
  statement: GvqlStatement;
  rows: Array<Record<string, unknown>>;
  matched: number;
  scannedObjects: number;
  elapsedMs: number;
  plan: GvqlExecutionPlan;
}

/** Describes the public GvqlMutationPreview contract. */
export interface GvqlMutationPreview {
  objectId: string;
  alias: string;
  path: string;
  before: unknown;
  after: unknown;
  operation?: "set" | "remove" | "detach" | "delete" | "create" | "attach" | "merge";
}

/** Describes the public GvqlMutationResult contract. */
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

/** Describes the public GvqlExecutableContext contract. */
export interface GvqlExecutableContext {
  envelope: SerializedEnvelope;
  transactionId?: number;
}

export type GvqlEncodedSetter = (objectId: string, path: string, value: EncodedValue) => void;
