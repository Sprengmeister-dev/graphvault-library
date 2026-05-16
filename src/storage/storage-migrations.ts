import type {
  SchemaMigrationMetadata,
  StorageMigrationPlanStep,
  StorageSchemaMigration,
} from "../core/types.js";

/** Runs the public targetSchemaVersion helper. */
export function targetSchemaVersion<TRoot>(explicitVersion: number | undefined, migrations: readonly StorageSchemaMigration<TRoot>[]): number {
  const targetVersion = explicitVersion ?? sortedSchemaMigrations(migrations).at(-1)?.version ?? 0;
  validateSchemaVersion(targetVersion, "schemaVersion");
  return targetVersion;
}

/** Runs the public sortedSchemaMigrations helper. */
export function sortedSchemaMigrations<TRoot>(migrations: readonly StorageSchemaMigration<TRoot>[]): Array<StorageSchemaMigration<TRoot>> {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const seen = new Set<number>();
  for (const migration of sorted) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
      throw new RangeError("Schema migration versions must be positive safe integers.");
    }
    if (seen.has(migration.version)) {
      throw new Error(`Duplicate schema migration version ${migration.version}.`);
    }
    seen.add(migration.version);
  }
  return sorted;
}

/** Runs the public migrationPlan helper. */
export function migrationPlan<TRoot>(
  currentVersion: number,
  targetVersion: number,
  migrations: readonly StorageSchemaMigration<TRoot>[],
): StorageMigrationPlanStep[] {
  validateSchemaVersion(currentVersion, "currentVersion");
  validateSchemaVersion(targetVersion, "targetVersion");
  if (currentVersion === targetVersion) {
    return [];
  }
  return targetVersion > currentVersion
    ? upMigrationPlan(currentVersion, targetVersion, migrations)
    : downMigrationPlan(currentVersion, targetVersion, migrations);
}

/** Runs the public migrationContext helper. */
export function migrationContext<TRoot>(
  root: TRoot,
  step: StorageMigrationPlanStep,
): Parameters<StorageSchemaMigration<TRoot>["up"]>[0] {
  return {
    root,
    direction: step.direction,
    fromVersion: step.fromVersion,
    toVersion: step.toVersion,
    version: step.version,
    ...(step.name ? { name: step.name } : {}),
  };
}

/** Runs the public migrationMetadata helper. */
export function migrationMetadata(step: StorageMigrationPlanStep): SchemaMigrationMetadata {
  return {
    version: step.version,
    ...(step.name ? { name: step.name } : {}),
    direction: step.direction,
    fromVersion: step.fromVersion,
    toVersion: step.toVersion,
  };
}

/** Runs the public validateSchemaVersion helper. */
export function validateSchemaVersion(version: number, label: string): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}

function upMigrationPlan<TRoot>(
  currentVersion: number,
  targetVersion: number,
  migrations: readonly StorageSchemaMigration<TRoot>[],
): StorageMigrationPlanStep[] {
  const byVersion = migrationsByVersion(migrations);
  const steps: StorageMigrationPlanStep[] = [];
  for (let version = currentVersion + 1; version <= targetVersion; version++) {
    steps.push(migrationPlanStep(requireMigration(byVersion, version), "up", version - 1, version));
  }
  return steps;
}

function downMigrationPlan<TRoot>(
  currentVersion: number,
  targetVersion: number,
  migrations: readonly StorageSchemaMigration<TRoot>[],
): StorageMigrationPlanStep[] {
  const byVersion = migrationsByVersion(migrations);
  const steps: StorageMigrationPlanStep[] = [];
  for (let version = currentVersion; version > targetVersion; version--) {
    steps.push(migrationPlanStep(requireMigration(byVersion, version), "down", version, version - 1));
  }
  return steps;
}

function migrationsByVersion<TRoot>(migrations: readonly StorageSchemaMigration<TRoot>[]): Map<number, StorageSchemaMigration<TRoot>> {
  return new Map(migrations.map((migration) => [migration.version, migration]));
}

function requireMigration<TRoot>(migrations: ReadonlyMap<number, StorageSchemaMigration<TRoot>>, version: number): StorageSchemaMigration<TRoot> {
  const migration = migrations.get(version);
  if (!migration) {
    throw new Error(`Missing schema migration for version ${version}.`);
  }
  return migration;
}

function migrationPlanStep<TRoot>(
  migration: StorageSchemaMigration<TRoot>,
  direction: StorageMigrationPlanStep["direction"],
  fromVersion: number,
  toVersion: number,
): StorageMigrationPlanStep {
  return {
    version: migration.version,
    ...(migration.name ? { name: migration.name } : {}),
    direction,
    fromVersion,
    toVersion,
  };
}
