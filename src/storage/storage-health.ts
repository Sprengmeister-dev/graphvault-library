import { assessStorageSafety } from "./storage-safety.js";
import type {
  StorageHealthOptions,
  StorageHealthReport,
  StorageOperationsStatus,
  StorageSafetyProfile,
  StorageWriteDurability,
  StorageWriteProfile,
  VerificationResult,
} from "../core/types.js";

export interface BuildStorageHealthReportInput {
  options: StorageHealthOptions;
  operations: StorageOperationsStatus;
  writeProfile: StorageWriteProfile;
  durability: StorageWriteDurability;
  writeSnapshots: boolean;
  recoverCommittedWal: boolean;
  readCommittedWal: boolean;
  commitValidatorCount: number;
  verify: () => Promise<VerificationResult>;
}

export async function buildStorageHealthReport(input: BuildStorageHealthReportInput): Promise<StorageHealthReport> {
  const safety = assessStorageSafety(input);
  const verification = input.options.verify === false ? undefined : await input.verify();
  const verificationOk = verification?.ok ?? true;
  const report: StorageHealthReport = {
    ok: verificationOk && safety.status !== "unsafe",
    status: healthStatus(safety.status, verificationOk),
    checkedAt: new Date().toISOString(),
    operations: input.operations,
    safety,
  };
  if (verification) {
    report.verification = verification;
  }
  return report;
}

function healthStatus(safetyStatus: StorageSafetyProfile["status"], verificationOk: boolean): StorageHealthReport["status"] {
  if (!verificationOk) {
    return "error";
  }
  if (safetyStatus === "unsafe") {
    return "unsafe";
  }
  if (safetyStatus === "warning") {
    return "warning";
  }
  return "healthy";
}
