import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), "graphvault-package-smoke-"));
let tarball;

try {
  const packOutput = execFileSync("npm", ["pack", "--json", "--cache", "./.npm-cache"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [packed] = JSON.parse(packOutput);
  tarball = join(root, packed.filename);

  await writeFile(
    join(temp, "package.json"),
    JSON.stringify(
      {
        type: "module",
        private: true,
        dependencies: {
          "@nestjs/common": "^11.1.21",
          "@nestjs/core": "^11.1.21",
          "@sprengmeister/graphvault": `file:${tarball}`,
          "reflect-metadata": "^0.2.2",
          rxjs: "^7.8.2",
        },
        devDependencies: {
          "@types/node": "^22.15.3",
          typescript: "^5.8.3",
        },
      },
      null,
      2,
    ),
  );
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(temp, ".npm-cache")], {
    cwd: temp,
    stdio: "inherit",
  });

  await writeFile(
    join(temp, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import {
  EmbeddedStorage,
  EncryptedStorageTarget,
  GraphVaultIgnore,
  GraphSerializer,
  MemoryStorageTarget,
  assessStorageSafety,
  startStorage,
} from "@sprengmeister/graphvault";
import { referencedEdges } from "@sprengmeister/graphvault/internal/gvql/gvql";
import { StorageLayout } from "@sprengmeister/graphvault/internal/storage/storage-layout";
import { MemoryStorageTarget as InternalMemoryStorageTarget } from "@sprengmeister/graphvault/internal/storage/storage-target";

const target = new MemoryStorageTarget();
const storage = await EmbeddedStorage.start({
  storageDirectory: "package-smoke",
  storageTarget: target,
  rootFactory: () => ({ documents: [{ id: "doc-1", title: "Package smoke" }] }),
});
await storage.storeRoot();
const subtree = await storage.loadSubtree({ depth: 1 });
assert.equal(subtree.objectIds.length >= 2, true);
const safety = await storage.safetyProfile();
assert.equal(["production-ready", "warning", "unsafe"].includes(safety.status), true);
const health = await storage.health({ verify: false });
assert.equal(health.ok, true);
assert.equal(health.status, "warning");
assert.equal(health.operations.objectCount >= 2, true);
assert.equal("verification" in health, false);
await storage.shutdown();

const assessed = assessStorageSafety({
  operations: {
    status: "healthy",
    storageDirectory: "package-smoke",
    readOnly: false,
    lockStrategy: "pessimistic",
    transactionLog: "full",
    lockTimeoutMs: 5000,
    staleLockTimeoutMs: 60000,
    channelCount: 1,
    publishedTransactionId: 1,
    schemaVersion: 0,
    latestJournalTransactionId: 1,
    latestWalTransactionId: 1,
    pendingWalCommits: 0,
    walPrepareFiles: 1,
    walCommitFiles: 1,
    objectCount: 1,
    latestTransactionHash: "hash",
  },
  writeProfile: "standard",
  durability: "strict",
  writeSnapshots: true,
  recoverCommittedWal: true,
  readCommittedWal: true,
  commitValidatorCount: 1,
});
assert.equal(assessed.status, "production-ready");

const encryptedRaw = new MemoryStorageTarget();
const encrypted = new EncryptedStorageTarget({ target: encryptedRaw, key: "package-smoke-key" });
await encrypted.writeTextAtomic("secure/value.txt", "secret");
assert.equal(await encrypted.readText("secure/value.txt"), "secret");
assert.equal((await encryptedRaw.readText("secure/value.txt")).includes("secret"), false);

const serializer = new GraphSerializer();
const envelope = serializer.serialize({ child: { ok: true } });
const rootNode = envelope.nodes[envelope.root.$ref];
assert.equal(referencedEdges(envelope.root.$ref, rootNode).length, 1);
class PackageAnnotatedModel {
  constructor() {
    this.visible = "visible";
    this.secret = "hidden";
  }
}
GraphVaultIgnore()(PackageAnnotatedModel.prototype, "secret");
const annotatedEnvelope = serializer.serialize(new PackageAnnotatedModel());
assert.equal("secret" in annotatedEnvelope.nodes[annotatedEnvelope.root.$ref].props, false);
assert.equal(new StorageLayout("store").manifestFile, "store/manifest.json");
assert.equal(new InternalMemoryStorageTarget() instanceof MemoryStorageTarget, true);

const viaFactory = await startStorage({
  storageDirectory: "factory-smoke",
  storageTarget: new MemoryStorageTarget(),
  rootFactory: () => ({ ok: true }),
});
await viaFactory.storeRoot();
await viaFactory.shutdown();

const migrationTarget = new MemoryStorageTarget();
const migrationStore = await EmbeddedStorage.start({
  storageDirectory: "migration-smoke",
  storageTarget: migrationTarget,
  schemaVersion: 0,
  rootFactory: () => ({ people: [{ fullName: "Package Smoke" }] }),
});
await migrationStore.storeRoot();
await migrationStore.shutdown();

const migratedStore = await EmbeddedStorage.start({
  storageDirectory: "migration-smoke",
  storageTarget: migrationTarget,
  schemaVersion: 1,
  schemaMigrations: [
    {
      version: 1,
      name: "split-name",
      up: ({ root }) => {
        root.people[0].firstName = "Package";
        root.people[0].lastName = "Smoke";
        delete root.people[0].fullName;
      },
      down: ({ root }) => {
        root.people[0].fullName = "Package Smoke";
        delete root.people[0].firstName;
        delete root.people[0].lastName;
      },
    },
  ],
});
assert.equal(migratedStore.migrationStatus().pending.length, 1);
await migratedStore.migrateTo();
assert.equal(migratedStore.currentSchemaVersion(), 1);
assert.deepEqual(migratedStore.root.people[0], { firstName: "Package", lastName: "Smoke" });
await migratedStore.migrateTo(0);
assert.deepEqual(migratedStore.root.people[0], { fullName: "Package Smoke" });
await migratedStore.shutdown();
`,
  );
  execFileSync("node", ["smoke.mjs"], { cwd: temp, stdio: "inherit" });
  await mkdir(join(temp, "src"), { recursive: true });
  await writeFile(
    join(temp, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2024",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          skipLibCheck: false,
          outDir: "dist",
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(temp, "src", "nest-smoke.ts"),
    `
import "reflect-metadata";
import assert from "node:assert/strict";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { GraphVaultModule, GraphVaultTransactional, StorageManager } from "@sprengmeister/graphvault";

interface CaseNote {
  id: string;
  title: string;
  status: "draft" | "approved";
}

class AppRoot {
  notes: CaseNote[] = [];
}

@Injectable()
class CasesService {
  constructor(readonly storage: StorageManager<AppRoot>) {}

  async create(title: string): Promise<CaseNote> {
    const note: CaseNote = { id: "case-1", title, status: "draft" };
    await this.storage.update((root) => {
      root.notes.push(note);
    });
    return note;
  }

  @GraphVaultTransactional({ mode: "pessimistic", managerProperty: "storage" })
  async approve(id: string): Promise<CaseNote> {
    const note = this.storage.root.notes.find((item) => item.id === id);
    if (!note) throw new Error("Missing note");
    note.status = "approved";
    return note;
  }

  list(): CaseNote[] {
    return [...this.storage.root.notes];
  }
}

@Module({
  imports: [
    GraphVaultModule.forRoot<AppRoot>({
      global: true,
      storageDirectory: "./nest-data/graphvault",
      rootFactory: () => new AppRoot(),
      types: [{ name: "AppRoot", ctor: AppRoot }],
      lockStrategy: "pessimistic",
      transactionLog: "full",
      recoverCommittedWal: true,
      readCommittedWal: true,
      staleLockTimeoutMs: 60_000,
      writeDurability: "strict",
    }),
  ],
  providers: [CasesService],
})
class AppModule {}

async function runOnce(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const cases = app.get(CasesService);
  const created = await cases.create("Package Nest smoke");
  await cases.approve(created.id);
  assert.deepEqual(cases.list(), [{ id: "case-1", title: "Package Nest smoke", status: "approved" }]);
  await app.close();
}

async function verifyRestart(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const cases = app.get(CasesService);
  assert.deepEqual(cases.list(), [{ id: "case-1", title: "Package Nest smoke", status: "approved" }]);
  await app.close();
}

await runOnce();
await verifyRestart();
`,
  );
  execFileSync(join(temp, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { cwd: temp, stdio: "inherit" });
  execFileSync("node", ["dist/nest-smoke.js"], { cwd: temp, stdio: "inherit" });
  console.log("GraphVault package smoke test passed.");
} finally {
  await rm(temp, { recursive: true, force: true });
  if (tarball) {
    await rm(tarball, { force: true });
  }
}
