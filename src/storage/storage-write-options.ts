import type {
  ObjectRecordWriteFormat,
  StorageManagerOptions,
  StorageWriteDurability,
  StorageWriteProfile,
} from "../core/types.js";

/** Describes the public ResolvedStorageWriteOptions contract. */
export interface ResolvedStorageWriteOptions {
  profile: StorageWriteProfile;
  objectRecordFormat: ObjectRecordWriteFormat;
  objectRecordWriteConcurrency: number;
  prettyJson: boolean;
  durability: StorageWriteDurability;
  writeSnapshots: boolean;
}

/** Runs the public resolveStorageWriteOptions helper. */
export function resolveStorageWriteOptions(options: StorageManagerOptions<any>): ResolvedStorageWriteOptions {
  const profile = options.writeProfile ?? "standard";
  return {
    profile,
    objectRecordFormat: options.objectRecordFormat ?? (profile === "standard" ? "binary-and-json" : "binary"),
    objectRecordWriteConcurrency: options.objectRecordWriteConcurrency ?? defaultObjectRecordWriteConcurrency(profile),
    prettyJson: options.prettyJson ?? profile === "standard",
    durability: options.writeDurability ?? (profile === "standard" ? "strict" : "relaxed"),
    writeSnapshots: options.writeSnapshots ?? profile !== "maximum",
  };
}

function defaultObjectRecordWriteConcurrency(profile: StorageWriteProfile): number {
  if (profile === "maximum") {
    return 128;
  }
  if (profile === "fast") {
    return 64;
  }
  return 32;
}
