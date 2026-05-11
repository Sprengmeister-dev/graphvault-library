import assert from "node:assert/strict";
import { EmbeddedStorage, MemoryStorageTarget } from "../dist/index.js";

const phases = [
  {
    name: "before-wal-commit",
    message: "simulated crash before WAL commit",
    expectedReadableItems: ["baseline"],
    expectedPendingWalCommits: 0,
  },
  {
    name: "before-transaction-record",
    message: "simulated crash before transaction record",
    expectedReadableItems: ["baseline", "after-crash"],
    expectedPendingWalCommits: 1,
  },
  {
    name: "before-parent-index",
    message: "simulated crash before parent index",
    expectedReadableItems: ["baseline", "after-crash"],
    expectedPendingWalCommits: 1,
  },
  {
    name: "before-current-pointer",
    message: "simulated crash before current pointer",
    expectedReadableItems: ["baseline", "after-crash"],
    expectedPendingWalCommits: 1,
  },
  {
    name: "before-manifest",
    message: "simulated crash before manifest",
    expectedReadableItems: ["baseline", "after-crash"],
    expectedPendingWalCommits: 1,
  },
];

async function assertCrashPhase(phase) {
  const storageDirectory = `wal-crash-${phase.name}`;
  const target = new PhaseCrashTarget();
  const baseline = await EmbeddedStorage.start({
    storageDirectory,
    storageTarget: target,
    lockStrategy: "pessimistic",
    rootFactory: () => ({ items: [] }),
  });
  baseline.root.items.push("baseline");
  await baseline.storeRoot();
  await baseline.shutdown();

  target.arm(phase.name);
  const crashingWriter = await EmbeddedStorage.start({
    storageDirectory,
    storageTarget: target,
    lockStrategy: "pessimistic",
    rootFactory: () => ({ items: [] }),
  });
  crashingWriter.root.items.push("after-crash");
  await assert.rejects(() => crashingWriter.storeRoot(), new RegExp(phase.message));
  const verificationAfterCrash = await crashingWriter.verify();
  assert.equal(verificationAfterCrash.ok, true, `${phase.name} should leave a verifiable or recoverable store`);
  assert.equal(verificationAfterCrash.pendingWalCommits, phase.expectedPendingWalCommits, phase.name);
  await crashingWriter.shutdown();

  const readOnlyView = await EmbeddedStorage.start({
    storageDirectory,
    storageTarget: target,
    readOnly: true,
    rootFactory: () => ({ items: [] }),
  });
  assert.deepEqual(readOnlyView.root.items, phase.expectedReadableItems, phase.name);
  await readOnlyView.shutdown();

  const recoveringWriter = await EmbeddedStorage.start({
    storageDirectory,
    storageTarget: target,
    lockStrategy: "pessimistic",
    rootFactory: () => ({ items: [] }),
  });
  assert.deepEqual(recoveringWriter.root.items, phase.expectedReadableItems, phase.name);
  const verificationAfterRecovery = await recoveringWriter.verify();
  assert.equal(verificationAfterRecovery.ok, true, phase.name);
  assert.equal(verificationAfterRecovery.pendingWalCommits, 0, phase.name);
  await recoveringWriter.shutdown();
}

class PhaseCrashTarget extends MemoryStorageTarget {
  phase = "";
  prepareWritten = false;
  commitMarkerWritten = false;
  failed = false;

  arm(phase) {
    this.phase = phase;
    this.prepareWritten = false;
    this.commitMarkerWritten = false;
    this.failed = false;
  }

  async writeTextAtomic(path, value) {
    if (path.includes("/wal/") && path.endsWith(".prepare.json")) {
      this.prepareWritten = true;
    }
    if (path.includes("/wal/") && path.endsWith(".commit.json")) {
      this.commitMarkerWritten = true;
    }
    this.failIfNeeded(path);
    await super.writeTextAtomic(path, value);
  }

  async writeBufferAtomic(path, value) {
    if (
      this.phase === "before-wal-commit" &&
      this.prepareWritten &&
      !this.commitMarkerWritten &&
      !this.failed &&
      !path.endsWith(".prepare.json")
    ) {
      this.failed = true;
      throw new Error("simulated crash before WAL commit");
    }
    await super.writeBufferAtomic(path, value);
  }

  failIfNeeded(path) {
    if (!this.commitMarkerWritten || this.failed) {
      return;
    }
    const shouldFail =
      (this.phase === "before-transaction-record" && path.includes("/transactions/") && path.endsWith(".json")) ||
      (this.phase === "before-parent-index" && path.endsWith("parent-index.json")) ||
      (this.phase === "before-current-pointer" && path.endsWith("CURRENT")) ||
      (this.phase === "before-manifest" && path.endsWith("manifest.json"));
    if (shouldFail) {
      this.failed = true;
      throw new Error(`simulated crash ${this.phase.replaceAll("-", " ")}`);
    }
  }
}

for (const phase of phases) {
  await assertCrashPhase(phase);
}
