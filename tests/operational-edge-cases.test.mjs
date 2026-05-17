import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphVaultModule, GraphVaultTransactional } from "../dist/integrations/nest.js";
import { projectGvqlRows } from "../dist/gvql/gvql-aggregation.js";
import { assessStorageSafety } from "../dist/storage/storage-safety.js";
import { StorageManager } from "../dist/storage/storage-manager.js";
import { verifyStorageIndexRecord } from "../dist/storage/storage-index-maintenance.js";

const safeOperations = {
  storageDirectory: "store",
  readOnly: false,
  lockStrategy: "pessimistic",
  transactionLog: "full",
  objectCount: 1,
  latestTransactionHash: "hash",
  pendingWalCommits: 0,
  staleLockTimeoutMs: 30_000,
};

const productionProfile = assessStorageSafety({
  operations: safeOperations,
  writeProfile: "production",
  durability: "strict",
  writeSnapshots: true,
  recoverCommittedWal: true,
  readCommittedWal: true,
  commitValidatorCount: 1,
});
assert.equal(productionProfile.status, "production-ready");
assert.equal(productionProfile.score, 100);
assert.equal(productionProfile.hashChain, "present");

const unsafeProfile = assessStorageSafety({
  operations: {
    ...safeOperations,
    transactionLog: "off",
    latestTransactionHash: undefined,
    pendingWalCommits: 2,
    staleLockTimeoutMs: undefined,
  },
  writeProfile: "balanced",
  durability: "relaxed",
  writeSnapshots: false,
  recoverCommittedWal: false,
  readCommittedWal: false,
  commitValidatorCount: 0,
});
assert.equal(unsafeProfile.status, "unsafe");
assert.equal(unsafeProfile.pendingRecovery, true);
assert.equal(unsafeProfile.hashChain, "missing");
assert.deepEqual(unsafeProfile.issues.map((issue) => issue.code), [
  "wal-recovery-pending",
  "transaction-log-disabled",
  "relaxed-durability",
  "snapshots-disabled",
  "stale-lock-recovery-disabled",
  "hash-chain-missing",
  "no-commit-validators",
]);

const warningProfile = assessStorageSafety({
  operations: { ...safeOperations, objectCount: 0, transactionLog: "full" },
  writeProfile: "balanced",
  durability: "strict",
  writeSnapshots: true,
  recoverCommittedWal: false,
  readCommittedWal: false,
  commitValidatorCount: 1,
});
assert.equal(warningProfile.status, "warning");
assert.equal(warningProfile.hashChain, "empty-store");
assert.equal(warningProfile.issues.some((issue) => issue.code === "wal-recovery-disabled"), true);
assert.equal(warningProfile.issues.some((issue) => issue.code === "wal-read-fallback-disabled"), true);

assert.deepEqual(verifyStorageIndexRecord({ expected: undefined, actual: undefined }), {
  ok: true,
  checkedIndexes: 0,
  errors: [],
  warnings: [],
});
assert.equal(verifyStorageIndexRecord({ expected: undefined, actual: indexRecord("actual") }).warnings.length, 1);
assert.equal(verifyStorageIndexRecord({ expected: indexRecord("expected"), actual: undefined }).errors.length, 1);
const matchingIndex = verifyStorageIndexRecord({ expected: indexRecord("same"), actual: { ...indexRecord("same"), createdAt: "later" } });
assert.equal(matchingIndex.ok, true);
assert.equal(matchingIndex.checkedIndexes, 2);
assert.equal(verifyStorageIndexRecord({ expected: indexRecord("left"), actual: indexRecord("right") }).ok, false);

const values = {
  1: { region: "eu", owner: "a", amount: 10, label: "Beta" },
  2: { region: "eu", owner: "b", amount: 7, label: "Alpha" },
  3: { region: "us", owner: "a", amount: 5, label: "Gamma" },
};

const rows = projectGvqlRows(
  {},
  [{ item: "1" }, { item: "2" }, { item: "3" }],
  {
    kind: "select",
    matches: [],
    returns: [
      { kind: "path", expression: { alias: "item", path: "region" }, aliasName: "region" },
      { kind: "count", expression: { alias: "item", path: "owner" }, distinct: true, aliasName: "owners" },
      { kind: "aggregate", fn: "sum", expression: { alias: "item", path: "amount" }, aliasName: "total" },
      { kind: "aggregate", fn: "avg", expression: { alias: "item", path: "amount" }, aliasName: "average" },
      { kind: "aggregate", fn: "min", expression: { alias: "item", path: "label" }, aliasName: "firstLabel" },
      { kind: "aggregate", fn: "max", expression: { alias: "item", path: "label" }, aliasName: "lastLabel" },
    ],
    groupBy: [{ alias: "item", path: "region" }],
  },
  (_index, binding, expression) => values[binding[expression.alias]][expression.path],
  () => undefined,
);
assert.deepEqual(rows, [
  { region: "eu", owners: 2, total: 17, average: 8.5, firstLabel: "Alpha", lastLabel: "Beta" },
  { region: "us", owners: 1, total: 5, average: 5, firstLabel: "Gamma", lastLabel: "Gamma" },
]);

const emptyAggregate = projectGvqlRows(
  {},
  [],
  {
    kind: "select",
    matches: [],
    returns: [
      { kind: "count", aliasName: "count" },
      { kind: "aggregate", fn: "avg", expression: { alias: "item", path: "amount" }, aliasName: "average" },
      { kind: "path", expression: { alias: "item", path: "region" }, aliasName: "region" },
    ],
  },
  () => undefined,
  () => undefined,
);
assert.deepEqual(emptyAggregate, [{ count: 0, average: null, region: undefined }]);

const module = GraphVaultModule.forRoot({ storageDirectory: "store", rootFactory: () => ({}) });
assert.equal(module.exports.includes(StorageManager), true);
const asyncModule = GraphVaultModule.forRootAsync({ global: true, inject: ["config"], useFactory: () => ({ storageDirectory: "store", rootFactory: () => ({}) }) });
assert.equal(asyncModule.global, true);
assert.deepEqual(asyncModule.providers[0].inject, ["config"]);

const temporaryDirectory = await mkdtemp(join(tmpdir(), "graphvault-nest-decorator-"));
try {
  const manager = await new StorageManager({ storageDirectory: temporaryDirectory, rootFactory: () => ({ calls: 0 }) }).start();
  class Service {
    storage = manager;

    async add(delta) {
      this.storage.root.calls += delta;
      return this.storage.root.calls;
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(Service.prototype, "add");
  GraphVaultTransactional()(Service.prototype, "add", descriptor);
  Object.defineProperty(Service.prototype, "add", descriptor);
  assert.equal(await new Service().add(2), 2);

  assert.throws(() => GraphVaultTransactional()({}, "bad", { value: 1 }), /can only decorate methods/);
  class MissingManager {
    async run() {}
  }
  const missingDescriptor = Object.getOwnPropertyDescriptor(MissingManager.prototype, "run");
  GraphVaultTransactional({ managerProperty: "missing" })(MissingManager.prototype, "run", missingDescriptor);
  Object.defineProperty(MissingManager.prototype, "run", missingDescriptor);
  await assert.rejects(() => new MissingManager().run(), /could not find a StorageManager/);
  await manager.shutdown();
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

function indexRecord(id) {
  return {
    format: "graphvault-index",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    graphHash: id,
    definitionsHash: id,
    nodesByType: { Case: ["1"] },
    property: { id },
    text: {},
    advanced: { definitions: [{ name: "idx", kind: "range", type: "Case", path: "id" }], records: {} },
    statistics: { nodes: 1, edges: 0, properties: 1 },
  };
}
