import { join } from "node:path";
import type { ObjectRecord, StorageManifest, StorageTarget, TransactionRecord, VerificationResult } from "./types.js";

export interface StorageVerifierOptions {
  target: StorageTarget;
  lazyDirectory: string;
  readManifest: () => Promise<StorageManifest | undefined>;
  readLatestTransactionRecord: () => Promise<TransactionRecord | undefined>;
  readObjectRecord: (objectId: string) => Promise<ObjectRecord>;
}

export async function verifyStorage(options: StorageVerifierOptions): Promise<VerificationResult> {
  const errors: string[] = [];
  let checkedObjects = 0;
  let checkedTransactions = 0;

  const manifest = await options.readManifest();
  if (!manifest) {
    errors.push("Missing or unreadable manifest.json.");
    return { ok: false, checkedObjects, checkedTransactions, errors };
  }

  const latestTransaction = await options.readLatestTransactionRecord();
  if (latestTransaction) {
    checkedTransactions++;
    if (latestTransaction.transactionId > manifest.transactionId) {
      errors.push(`Manifest transaction ${manifest.transactionId} is behind latest transaction ${latestTransaction.transactionId}.`);
    }
  }

  const knownObjects = new Set(manifest.objectIds);
  const referencedObjects = new Set<string>();
  const referencedLazyFiles = new Set<string>();
  if (manifest.root && typeof manifest.root === "object" && "$ref" in manifest.root) {
    referencedObjects.add(manifest.root.$ref);
  }

  for (const objectId of manifest.objectIds) {
    let record: ObjectRecord;
    try {
      record = await options.readObjectRecord(objectId);
      checkedObjects++;
    } catch {
      errors.push(`Missing or unreadable object record ${objectId}.`);
      continue;
    }
    if (record.objectId !== objectId) {
      errors.push(`Object record ${objectId} contains mismatched objectId ${record.objectId}.`);
    }
    collectReferences(record.node, referencedObjects, referencedLazyFiles);
  }

  for (const objectId of referencedObjects) {
    if (!knownObjects.has(objectId)) {
      errors.push(`Object ${objectId} is referenced but not listed in manifest.`);
    }
  }

  for (const lazyFile of referencedLazyFiles) {
    if (!(await options.target.exists(join(options.lazyDirectory, lazyFile)))) {
      errors.push(`Lazy file ${lazyFile} is referenced but missing.`);
    }
  }

  return { ok: errors.length === 0, checkedObjects, checkedTransactions, errors };
}

function collectReferences(node: ObjectRecord["node"], objectRefs: Set<string>, lazyFiles: Set<string>): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }
    if ("$ref" in value && typeof value.$ref === "string") {
      objectRefs.add(value.$ref);
      return;
    }
    if ("$type" in value) {
      return;
    }
  };

  switch (node.kind) {
    case "array":
      for (const item of node.items) {
        visit(item);
      }
      break;
    case "map":
      for (const [key, value] of node.entries) {
        visit(key);
        visit(value);
      }
      break;
    case "set":
      for (const item of node.items) {
        visit(item);
      }
      break;
    case "object":
      for (const value of Object.values(node.props)) {
        visit(value);
      }
      for (const [key, value] of node.symbolProps ?? []) {
        visit(key);
        visit(value);
      }
      break;
    case "lazy":
      lazyFiles.add(`${encodeURIComponent(node.key)}.json`);
      break;
  }
}
