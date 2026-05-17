import type {
  ObjectRecordWriteFormat,
  StorageManagerOptions,
  StorageWriteDurability,
  StorageWriteProfile,
} from "../core/types.js";

/** Normalized write-profile settings used by the writer and committer. */
export interface ResolvedStorageWriteOptions {
  profile: StorageWriteProfile;
  objectRecordFormat: ObjectRecordWriteFormat;
  objectRecordWriteConcurrency: number;
  prettyJson: boolean;
  durability: StorageWriteDurability;
  writeSnapshots: boolean;
}

/** Normalizes a write profile into object-record, durability, snapshot, and concurrency settings. */
export function resolveStorageWriteOptions(options: StorageManagerOptions<any>): ResolvedStorageWriteOptions {
  const profile = options.writeProfile ?? "production";
  const inspectable = profile === "inspect";
  return {
    profile,
    objectRecordFormat: options.objectRecordFormat ?? (inspectable ? "binary-and-json" : "binary"),
    objectRecordWriteConcurrency: options.objectRecordWriteConcurrency ?? defaultObjectRecordWriteConcurrency(profile),
    prettyJson: options.prettyJson ?? inspectable,
    durability: options.writeDurability ?? (inspectable ? "strict" : "relaxed"),
    writeSnapshots: options.writeSnapshots ?? profile !== "production",
  };
}

function defaultObjectRecordWriteConcurrency(profile: StorageWriteProfile): number {
  if (profile === "production") {
    return 128;
  }
  if (profile === "balanced") {
    return 64;
  }
  return 32;
}
