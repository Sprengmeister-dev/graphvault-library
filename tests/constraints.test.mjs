import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EmbeddedStorage,
  GraphVaultConstraint,
  GraphVaultEnum,
  GraphVaultMax,
  GraphVaultMin,
  GraphVaultReferenceExists,
  GraphVaultRequired,
  GraphVaultType,
  GraphVaultUnique,
  StorageConstraintViolationError,
  graphVaultConstraintDefinitionsForTypes,
  graphVaultConstraintsForPrototype,
  registerGraphVaultConstraint,
} from "../dist/index.js";
import { validateStorageConstraints } from "../dist/storage/storage-constraints.js";

class Account {
  constructor(id, email, status = "active", score = 10) {
    this.id = id;
    this.email = email;
    this.status = status;
    this.score = score;
  }
}

GraphVaultRequired()(Account.prototype, "id");
GraphVaultType("string")(Account.prototype, "id");
GraphVaultUnique()(Account.prototype, "email");
GraphVaultEnum(["active", "locked"])(Account.prototype, "status");
GraphVaultMin(0)(Account.prototype, "score");
GraphVaultMax(100)(Account.prototype, "score");

const storageDirectory = await mkdtemp(join(tmpdir(), "graphvault-constraints-"));

try {
  const storage = await EmbeddedStorage.start({
    storageDirectory,
    types: [{ name: "Account", ctor: Account }],
    rootFactory: () => ({
      accounts: [
        new Account("acc-1", "one@example.com", "active", 5),
        new Account("acc-2", "two@example.com", "locked", 75),
      ],
    }),
  });

  await storage.storeRoot();
  const record = await storage.constraintRecord();
  assert.equal(record?.format, "graphvault-constraints");
  assert.equal(record.definitions.length, 4);
  assert.equal(record.validation.ok, true);

  storage.root.accounts[1].email = "one@example.com";
  await assert.rejects(() => storage.store(storage.root.accounts[1]), StorageConstraintViolationError);
  let report = await storage.validateConstraints();
  assert.equal(report.ok, false);
  assert.equal(report.violations.some((violation) => violation.kind === "unique" && violation.path === "email"), true);

  storage.root.accounts[1].email = "two@example.com";
  storage.root.accounts[1].status = "deleted";
  report = await storage.validateConstraints();
  assert.equal(report.violations.some((violation) => violation.kind === "enum" && violation.path === "status"), true);

  storage.root.accounts[1].status = "active";
  storage.root.accounts[1].score = 101;
  report = await storage.validateConstraints();
  assert.equal(report.violations.some((violation) => violation.kind === "max" && violation.path === "score"), true);

  storage.root.accounts[1].score = 25;
  storage.root.accounts[0].id = undefined;
  await assert.rejects(() => storage.store(storage.root.accounts[0]), /Account.id/);
  storage.root.accounts[0].id = "acc-1";
  await storage.storeRoot();
  await storage.shutdown();

  const disabled = await EmbeddedStorage.start({
    storageDirectory: `${storageDirectory}-disabled`,
    types: [{ name: "Account", ctor: Account }],
    constraints: false,
    rootFactory: () => ({ accounts: [new Account(undefined, "same@example.com"), new Account(undefined, "same@example.com")] }),
  });
  await disabled.storeRoot();
  assert.equal(await disabled.constraintRecord(), undefined);
  await disabled.shutdown();

  const brokenReferenceEnvelope = {
    format: "graphvault",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    root: { $ref: "1" },
    nodes: {
      1: { kind: "object", type: "Project", props: { owner: { $ref: "missing" } } },
    },
  };
  const referenceReport = validateStorageConstraints({
    envelope: brokenReferenceEnvelope,
    options: {
      mode: "enforce",
      definitions: [{ name: "Project.owner", type: "Project", path: "owner", referenceExists: true }],
    },
  });
  assert.equal(referenceReport.ok, false);
  assert.equal(referenceReport.violations[0].kind, "referenceExists");

  const validReferenceEnvelope = {
    format: "graphvault",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    root: { $ref: "1" },
    nodes: {
      1: { kind: "object", type: "Project", props: { owner: { $ref: "2" } } },
      2: { kind: "object", type: "User", props: { id: "user-1" } },
    },
  };
  const referenceTypeReport = validateStorageConstraints({
    envelope: validReferenceEnvelope,
    options: {
      mode: "enforce",
      definitions: [{ name: "Project.owner.reference", type: "Project", path: "owner", valueType: "reference" }],
    },
  });
  assert.equal(referenceTypeReport.ok, true);

  class Project {
    owner = undefined;
  }
  GraphVaultReferenceExists()(Project.prototype, "owner");
  registerGraphVaultConstraint(Project.prototype, "code", { required: true, valueType: "string" });
  const projectDefinitions = graphVaultConstraintDefinitionsForTypes([{ name: "Project", ctor: Project }]);
  assert.equal(projectDefinitions.some((definition) => definition.path === "owner" && definition.referenceExists), true);
  assert.equal(projectDefinitions.some((definition) => definition.path === "code" && definition.required), true);
  assert.equal(graphVaultConstraintsForPrototype(Project.prototype).get("owner").referenceExists, true);

  let standardInitializer;
  GraphVaultConstraint({ required: true })({}, {
    kind: "field",
    name: "standardRequired",
    addInitializer: (initializer) => {
      standardInitializer = initializer;
    },
  });
  class StandardThing {}
  const standardInstance = new StandardThing();
  standardInitializer.call(standardInstance);
  assert.equal(graphVaultConstraintsForPrototype(Object.getPrototypeOf(standardInstance)).get("standardRequired").required, true);
  assert.throws(
    () => GraphVaultConstraint({ required: true })({}, { kind: "method", name: "invalid" }),
    /can only decorate fields/,
  );
} finally {
  await rm(storageDirectory, { recursive: true, force: true });
  await rm(`${storageDirectory}-disabled`, { recursive: true, force: true });
}
