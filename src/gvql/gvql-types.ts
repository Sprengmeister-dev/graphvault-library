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

/** Represents GVQL Node Pattern in the public GraphVault data model. */
export interface GvqlNodePattern {
  alias: string;
  type?: string;
}

/** Represents GVQL Edge Pattern in the public GraphVault data model. */
export interface GvqlEdgePattern {
  direction: GvqlDirection;
  label?: string;
}

/** Represents GVQL Match Pattern in the public GraphVault data model. */
export interface GvqlMatchPattern {
  start: GvqlNodePattern;
  chain: Array<{ edge: GvqlEdgePattern; node: GvqlNodePattern }>;
}

/** Represents GVQL Path Expression in the public GraphVault data model. */
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

/** Represents GVQL Predicate in the public GraphVault data model. */
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

/** Represents GVQL Row Reference in the public GraphVault data model. */
export interface GvqlRowReference {
  aliasName: string;
}

/** Represents GVQL Row Predicate in the public GraphVault data model. */
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

/** Represents GVQL Set Expression in the public GraphVault data model. */
export interface GvqlSetExpression {
  target: GvqlPathExpression;
  value: GvqlSetValueExpression;
}

/** Represents GVQL Remove Expression in the public GraphVault data model. */
export interface GvqlRemoveExpression {
  target: GvqlPathExpression;
}

/** Represents GVQL Delete Expression in the public GraphVault data model. */
export interface GvqlDeleteExpression {
  alias: string;
}

/** Represents GVQL Create Expression in the public GraphVault data model. */
export interface GvqlCreateExpression {
  alias: string;
  type?: string;
  props: Record<string, GvqlValueExpression>;
  into: GvqlPathExpression;
}

/** Represents GVQL Merge Expression in the public GraphVault data model. */
export interface GvqlMergeExpression extends GvqlCreateExpression {
  on: GvqlPathExpression;
}

export type GvqlOrderExpression =
  | { kind: "path"; expression: GvqlPathExpression }
  | { kind: "alias"; aliasName: string };

/** Represents GVQL Order By in the public GraphVault data model. */
export interface GvqlOrderBy {
  expression: GvqlOrderExpression;
  direction: "asc" | "desc";
}

/** Represents GVQL With Clause in the public GraphVault data model. */
export interface GvqlWithClause {
  returns: GvqlReturnExpression[];
  distinct: boolean;
  where?: GvqlHavingClause;
}

/** Represents GVQL Statement in the public GraphVault data model. */
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

/** Represents GVQL Graph Node in the public GraphVault data model. */
export interface GvqlGraphNode {
  objectId: string;
  kind: string;
  type?: string;
}

/** Directed graph edge representation used by GVQL Graph. */
export interface GvqlGraphEdge {
  from: string;
  to: string;
  path: string;
  label: string;
}

/** In-memory graph index used by GVQL to avoid full graph scans where possible. */
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

/** Represents GVQL Advanced Graph Index in the public GraphVault data model. */
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

/** Execution options for GVQL queries, previews, graph indexes, limits, and mutation permissions. */
export interface GvqlExecutionOptions {
  parameters?: Record<string, unknown>;
  allowMutations?: boolean;
  dryRun?: boolean;
  graphIndex?: GvqlGraphIndex;
}

export type GvqlCandidateSource = "property-index" | "composite-index" | "range-index" | "text-index" | "fulltext-index" | "expression-index" | "unique-index" | "type-index" | "id-index" | "full-scan";

/** Index-selection and scan information returned with a GVQL result when planning is requested. */
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

/** Rows, columns, plan, and summary returned by a read-only GVQL query. */
export interface GvqlQueryResult {
  kind: "select";
  statement: GvqlStatement;
  rows: Array<Record<string, unknown>>;
  matched: number;
  scannedObjects: number;
  elapsedMs: number;
  plan: GvqlExecutionPlan;
}

/** Represents GVQL Mutation Preview in the public GraphVault data model. */
export interface GvqlMutationPreview {
  objectId: string;
  alias: string;
  path: string;
  before: unknown;
  after: unknown;
  operation?: "set" | "remove" | "detach" | "delete" | "create" | "attach" | "merge";
}

/** Changes, preview data, and optional store metadata returned by a mutating GVQL statement. */
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

/** Runtime graph, index, and mutation settings used by the GVQL executor. */
export interface GvqlExecutableContext {
  envelope: SerializedEnvelope;
  transactionId?: number;
}

export type GvqlEncodedSetter = (objectId: string, path: string, value: EncodedValue) => void;
