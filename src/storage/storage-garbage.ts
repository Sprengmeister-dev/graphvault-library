import { join } from "node:path";
import type { GarbageCollectionResult, SerializedEnvelope, StorageManifest, StorageTarget } from "../core/types.js";
import type { StorageLayout } from "./storage-layout.js";
import type { StorageReader } from "./storage-reader.js";

export async function collectStorageGarbage(input: {
  target: StorageTarget;
  layout: StorageLayout;
  reader: StorageReader;
}): Promise<GarbageCollectionResult> {
  const manifest = await input.reader.readManifest();
  if (!manifest) {
    return emptyGarbageCollectionResult();
  }
  const envelope = await input.reader.envelopeFromManifest(manifest);
  const jsonRecords = await collectObjectRecords(input, manifest, "json");
  const binaryRecords = await collectObjectRecords(input, manifest, "bin");
  const lazyFiles = await collectLazyFiles(input, envelope);
  return {
    keptObjects: jsonRecords.kept,
    removedObjects: jsonRecords.removed,
    keptBinaryObjects: binaryRecords.kept,
    removedBinaryObjects: binaryRecords.removed,
    keptLazyFiles: lazyFiles.keptLazyFiles,
    removedLazyFiles: lazyFiles.removedLazyFiles,
  };
}

function emptyGarbageCollectionResult(): GarbageCollectionResult {
  return {
    keptObjects: 0,
    removedObjects: 0,
    keptBinaryObjects: 0,
    removedBinaryObjects: 0,
    keptLazyFiles: 0,
    removedLazyFiles: 0,
  };
}

async function collectObjectRecords(
  input: { target: StorageTarget; layout: StorageLayout; reader: StorageReader },
  manifest: StorageManifest,
  extension: "json" | "bin",
): Promise<{ kept: number; removed: number }> {
  const liveRecords = liveObjectRecordFiles(manifest, extension);
  let kept = 0;
  let removed = 0;
  for (const directory of input.layout.objectRecordDirectories(extension === "json" ? "json" : "binary")) {
    for (const file of await input.reader.readDirectoryIfExists(directory)) {
      if (!file.endsWith(`.${extension}`)) {
        continue;
      }
      if (liveRecords.has(file)) {
        kept++;
      } else {
        await input.target.remove(join(directory, file));
        removed++;
      }
    }
  }
  return { kept, removed };
}

async function collectLazyFiles(
  input: { target: StorageTarget; layout: StorageLayout; reader: StorageReader },
  envelope: SerializedEnvelope,
): Promise<Pick<GarbageCollectionResult, "keptLazyFiles" | "removedLazyFiles">> {
  const liveLazyFiles = liveLazyRecordFiles(envelope);
  let keptLazyFiles = 0;
  let removedLazyFiles = 0;
  for (const file of await input.reader.readDirectoryIfExists(input.layout.lazyDirectory)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    if (liveLazyFiles.has(file)) {
      keptLazyFiles++;
    } else {
      await input.target.remove(join(input.layout.lazyDirectory, file));
      removedLazyFiles++;
    }
  }
  return { keptLazyFiles, removedLazyFiles };
}

function liveLazyRecordFiles(envelope: SerializedEnvelope): Set<string> {
  const files = new Set<string>();
  for (const node of Object.values(envelope.nodes)) {
    if (node.kind === "lazy") {
      files.add(`${encodeURIComponent(node.key)}.json`);
    }
  }
  return files;
}

function liveObjectRecordFiles(manifest: StorageManifest, extension: "json" | "bin"): Set<string> {
  const files = new Set<string>();
  for (const objectId of manifest.objectIds) {
    files.add(`${objectId}.${extension}`);
    files.add(`${objectId}.${manifest.objectVersions?.[objectId] ?? manifest.transactionId}.${extension}`);
  }
  return files;
}
