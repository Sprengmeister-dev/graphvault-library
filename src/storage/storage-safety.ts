import type {
  StorageOperationsStatus,
  StorageSafetyIssue,
  StorageSafetyProfile,
  StorageWriteDurability,
  StorageWriteProfile,
} from "../core/types.js";

export interface StorageSafetyAssessmentInput {
  operations: StorageOperationsStatus;
  writeProfile: StorageWriteProfile;
  durability: StorageWriteDurability;
  writeSnapshots: boolean;
  recoverCommittedWal: boolean;
  readCommittedWal: boolean;
  commitValidatorCount: number;
}

export function assessStorageSafety(input: StorageSafetyAssessmentInput): StorageSafetyProfile {
  const issues: StorageSafetyIssue[] = [];
  const { operations } = input;

  if (operations.pendingWalCommits > 0) {
    issues.push({
      code: "wal-recovery-pending",
      severity: "critical",
      message: `${operations.pendingWalCommits} committed WAL record(s) are newer than the published manifest.`,
      recommendation: "Start a writable GraphVault instance with WAL recovery enabled before serving the store.",
    });
  }

  if (operations.transactionLog === "off") {
    issues.push({
      code: "transaction-log-disabled",
      severity: "critical",
      message: "The transaction log is disabled, so GraphVault cannot recover committed WAL records after a crash.",
      recommendation: 'Use transactionLog: "full" for critical or shared stores.',
    });
  }

  if (input.durability === "relaxed") {
    issues.push({
      code: "relaxed-durability",
      severity: "warning",
      message: "Writes use relaxed durability, which favors throughput over stronger local flush behavior.",
      recommendation: 'Use writeDurability: "strict" for critical data and reserve relaxed durability for caches or rebuildable stores.',
    });
  }

  if (!input.writeSnapshots) {
    issues.push({
      code: "snapshots-disabled",
      severity: "warning",
      message: "Full graph snapshots are disabled, leaving object records and WAL as the only recovery surfaces.",
      recommendation: "Keep snapshots enabled unless the store is disposable or independently snapshotted by infrastructure.",
    });
  }

  if (!operations.staleLockTimeoutMs) {
    issues.push({
      code: "stale-lock-recovery-disabled",
      severity: "warning",
      message: "Stale writer-lock recovery is not configured, so a crashed writer may require manual lock cleanup.",
      recommendation: "Configure staleLockTimeoutMs above the longest expected transaction runtime for multi-pod stores.",
    });
  }

  if (operations.transactionLog === "full" && !input.recoverCommittedWal) {
    issues.push({
      code: "wal-recovery-disabled",
      severity: "warning",
      message: "Committed WAL recovery is disabled for writable startup.",
      recommendation: "Leave recoverCommittedWal enabled so the next writer can finish publishing committed transactions.",
    });
  }

  if (operations.transactionLog === "full" && !input.readCommittedWal) {
    issues.push({
      code: "wal-read-fallback-disabled",
      severity: "warning",
      message: "Readers are not allowed to load committed WAL records that are newer than the manifest.",
      recommendation: "Leave readCommittedWal enabled for read-committed behavior during recovery windows.",
    });
  }

  if (operations.objectCount > 0 && !operations.latestTransactionHash) {
    issues.push({
      code: "hash-chain-missing",
      severity: "warning",
      message: "The latest manifest does not expose a transaction hash-chain head.",
      recommendation: "Rewrite the store with a current GraphVault version to restore tamper-evident transaction history.",
    });
  }

  if (input.commitValidatorCount === 0) {
    issues.push({
      code: "no-commit-validators",
      severity: "info",
      message: "No application commit validators are configured.",
      recommendation: "Use commitValidators for business invariants that must be checked at the storage boundary.",
    });
  }

  return {
    status: statusFromIssues(issues),
    score: scoreFromIssues(issues),
    summary: summaryFromIssues(issues),
    storageDirectory: operations.storageDirectory,
    readOnly: operations.readOnly,
    lockStrategy: operations.lockStrategy,
    transactionLog: operations.transactionLog,
    durability: input.durability,
    writeProfile: input.writeProfile,
    staleLockRecovery: typeof operations.staleLockTimeoutMs === "number",
    recoverCommittedWal: input.recoverCommittedWal,
    readCommittedWal: input.readCommittedWal,
    writeSnapshots: input.writeSnapshots,
    commitValidatorCount: input.commitValidatorCount,
    pendingRecovery: operations.pendingWalCommits > 0,
    hashChain: operations.objectCount === 0 ? "empty-store" : operations.latestTransactionHash ? "present" : "missing",
    issues,
  };
}

function statusFromIssues(issues: StorageSafetyIssue[]): StorageSafetyProfile["status"] {
  if (issues.some((issue) => issue.severity === "critical")) {
    return "unsafe";
  }
  if (issues.some((issue) => issue.severity === "warning")) {
    return "warning";
  }
  return "production-ready";
}

function scoreFromIssues(issues: StorageSafetyIssue[]): number {
  const penalty = issues.reduce((total, issue) => {
    if (issue.severity === "critical") return total + 35;
    if (issue.severity === "warning") return total + 12;
    return total + 2;
  }, 0);
  return Math.max(0, 100 - penalty);
}

function summaryFromIssues(issues: StorageSafetyIssue[]): string {
  if (issues.some((issue) => issue.severity === "critical")) {
    return "Not safe for critical production writes until critical issues are resolved.";
  }
  if (issues.some((issue) => issue.severity === "warning")) {
    return "Usable with caveats; review warnings before using for critical or multi-pod stores.";
  }
  return "Configured for critical production use according to GraphVault's local safety checks.";
}
