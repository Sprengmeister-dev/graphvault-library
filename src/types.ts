export type ClassConstructor<T = object> = new (...args: never[]) => T;

export interface TypeRegistration<T extends object = object> {
  name: string;
  ctor: ClassConstructor<T>;
  version?: number;
  create?: () => T;
  serialize?: (value: T) => Record<string, unknown>;
  hydrate?: (target: T, state: Record<string, unknown>, fromVersion: number) => void;
  migrate?: (state: Record<string, unknown>, fromVersion: number) => Record<string, unknown>;
}

export interface SerializedEnvelope {
  format: "graphvault";
  version: 1;
  createdAt: string;
  root: EncodedValue;
  nodes: Record<string, EncodedNode>;
}

export interface ObjectRecord {
  format: "graphvault-object";
  version: 1;
  objectId: string;
  transactionId: number;
  storedAt: string;
  node: EncodedNode;
}

export interface StorageManifest {
  format: "graphvault-manifest";
  version: 1;
  transactionId: number;
  createdAt: string;
  root: EncodedValue;
  objectIds: string[];
}

export interface TransactionRecord {
  format: "graphvault-transaction";
  version: 1;
  transactionId: number;
  committedAt: string;
  snapshotFile: string;
  objectIds: string[];
  mode: StoreMode;
  targetCount: number;
}

export interface TypeDictionary {
  format: "graphvault-type-dictionary";
  version: 1;
  types: TypeDictionaryEntry[];
}

export interface ParentIndexRecord {
  format: "graphvault-parent-index";
  version: 1;
  transactionId: number;
  rootObjectId?: string;
  parents: Record<string, ParentReference[]>;
}

export interface ParentReference {
  parentObjectId: string;
  path: string;
}

export interface TypeDictionaryEntry {
  name: string;
  version: number;
  constructorName: string;
}

export type EncodedValue =
  | null
  | string
  | number
  | boolean
  | { $type: "undefined" }
  | { $type: "number"; value: "NaN" | "Infinity" | "-Infinity" | "-0" }
  | { $type: "bigint"; value: string }
  | { $type: "symbol"; global?: true; key: string | null }
  | { $type: "date"; value: string }
  | { $type: "buffer"; value: string }
  | { $type: "regexp"; source: string; flags: string }
  | { $type: "url"; value: string }
  | { $type: "urlsearchparams"; value: string }
  | { $type: "error"; name: string; message: string; stack?: string; cause?: EncodedValue; errors?: EncodedValue[] }
  | { $type: "arraybuffer"; value: string }
  | { $type: "sharedarraybuffer"; value: string }
  | { $type: "dataview"; value: string }
  | { $type: "typedarray"; ctor: TypedArrayName; value: string }
  | { $ref: string };

export type TypedArrayName =
  | "Int8Array"
  | "Uint8Array"
  | "Uint8ClampedArray"
  | "Int16Array"
  | "Uint16Array"
  | "Int32Array"
  | "Uint32Array"
  | "Float32Array"
  | "Float64Array"
  | "BigInt64Array"
  | "BigUint64Array";

export type EncodedNode =
  | { kind: "array"; items: EncodedValue[] }
  | { kind: "map"; entries: Array<[EncodedValue, EncodedValue]> }
  | { kind: "set"; items: EncodedValue[] }
  | { kind: "object"; type?: string; version?: number; props: Record<string, EncodedValue>; symbolProps?: Array<[EncodedValue, EncodedValue]> }
  | { kind: "lazy"; key: string };

export interface StorageManagerOptions<TRoot = unknown> {
  storageDirectory: string;
  rootFactory: () => TRoot;
  customRoot?: TRoot;
  types?: Array<TypeRegistration<any>>;
  readOnly?: boolean;
  lockTimeoutMs?: number;
  housekeepingIntervalMs?: number;
  eagerFieldEvaluator?: EagerFieldEvaluator;
  storageTarget?: StorageTarget;
  channelCount?: number;
  writeProfile?: StorageWriteProfile;
  objectRecordFormat?: ObjectRecordWriteFormat;
  objectRecordWriteConcurrency?: number;
  prettyJson?: boolean;
  writeDurability?: StorageWriteDurability;
  writeSnapshots?: boolean;
}

export interface StorageTarget {
  ensureDirectory(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>;
  readText(path: string): Promise<string>;
  readBuffer(path: string): Promise<Buffer>;
  writeTextAtomic(path: string, value: string): Promise<void>;
  writeBufferAtomic(path: string, value: Buffer): Promise<void>;
  appendText(path: string, value: string): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  acquireLock(path: string, timeoutMs: number): Promise<StorageTargetLock>;
}

export interface StorageTargetLock {
  release(): Promise<void>;
}

export interface StoreMetadata {
  transactionId: number;
  storedAt: Date;
  snapshotFile: string;
  journalFile: string;
  mode: StoreMode;
  objectCount: number;
  objectIds: string[];
}

export interface StorageStatus {
  started: boolean;
  readOnly: boolean;
  storageDirectory: string;
  transactionId: number;
  hasRoot: boolean;
  recoveredFrom?: "manifest" | "snapshot" | "empty";
  housekeepingActive: boolean;
  registeredTypes: number;
  channelCount: number;
}

export interface CompactionResult {
  kept: number;
  removed: number;
}

export interface GarbageCollectionResult {
  keptObjects: number;
  removedObjects: number;
  keptBinaryObjects: number;
  removedBinaryObjects: number;
  keptLazyFiles: number;
  removedLazyFiles: number;
}

export interface BackupResult {
  filesCopied: number;
  transactionId: number;
}

export interface VerificationResult {
  ok: boolean;
  checkedObjects: number;
  checkedTransactions: number;
  errors: string[];
}

export interface MaintenanceOptions {
  keepSnapshots?: number;
  verify?: boolean;
}

export interface MaintenanceResult {
  garbageCollection: GarbageCollectionResult;
  compaction: CompactionResult;
  verification?: VerificationResult;
}

export type StoreMode = "standard" | "lazy" | "eager";

export type StorageWriteProfile = "standard" | "fast" | "maximum";

export type ObjectRecordWriteFormat = "binary-and-json" | "binary" | "json";

export type StorageWriteDurability = "strict" | "relaxed";

export type EagerFieldEvaluator = (context: {
  owner: object;
  fieldName: string;
  value: unknown;
}) => boolean;
