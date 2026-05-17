import { StorageConstraintViolationError } from "../core/errors.js";
import type {
  EncodedNode,
  EncodedValue,
  SerializedEnvelope,
  StorageConstraintDefinition,
  StorageConstraintMode,
  StorageConstraintOptions,
  StorageConstraintValidationResult,
  StorageConstraintViolation,
} from "../core/types.js";

/** Normalized constraint configuration used by the commit path. */
export interface ResolvedStorageConstraintOptions {
  mode: StorageConstraintMode;
  definitions: StorageConstraintDefinition[];
}

/** Normalizes shorthand constraint configuration and annotated definitions into an explicit plan. */
export function resolveStorageConstraintOptions(
  options: boolean | StorageConstraintOptions | undefined,
  annotatedDefinitions: StorageConstraintDefinition[] = [],
): ResolvedStorageConstraintOptions {
  if (options === false) {
    return { mode: "off", definitions: [] };
  }
  const configuredDefinitions = typeof options === "object" ? options.definitions ?? [] : [];
  return {
    mode: typeof options === "object" ? options.mode ?? "enforce" : "enforce",
    definitions: [...annotatedDefinitions, ...configuredDefinitions],
  };
}

/** Validates the requested object IDs against the active storage constraints. */
export function validateStorageConstraints(input: {
  envelope: SerializedEnvelope;
  options: ResolvedStorageConstraintOptions;
  objectIds?: readonly string[];
  throwOnViolation?: boolean;
}): StorageConstraintValidationResult {
  const definitions = input.options.mode === "off" ? [] : input.options.definitions;
  const objectIds = input.objectIds?.length ? new Set(input.objectIds) : undefined;
  const targetNodes = objectEntries(input.envelope).filter(isTargetObjectEntry(objectIds));
  const violations: StorageConstraintViolation[] = [];

  for (const definition of definitions) {
    for (const [objectId, node] of targetNodes) {
      if (!matchesDefinitionType(node, definition)) {
        continue;
      }
      validateField(definition, objectId, node, input.envelope, violations);
    }
    if (definition.unique) {
      validateUnique(definition, input.envelope, objectIds, violations);
    }
  }

  const result: StorageConstraintValidationResult = {
    ok: violations.length === 0,
    mode: input.options.mode,
    checkedObjects: targetNodes.length,
    checkedConstraints: definitions.length,
    violations,
  };
  if (!result.ok && input.options.mode === "enforce" && input.throwOnViolation) {
    throw new StorageConstraintViolationError(formatConstraintError(result));
  }
  return result;
}

function validateField(
  definition: StorageConstraintDefinition,
  objectId: string,
  node: Extract<EncodedNode, { kind: "object" }>,
  envelope: SerializedEnvelope,
  violations: StorageConstraintViolation[],
): void {
  const value = node.props[definition.path];
  if (definition.required && isMissing(value)) {
    violations.push(violation(definition, "required", objectId, "Field is required.", value));
    return;
  }
  if (isMissing(value)) {
    return;
  }
  const presentValue = value as EncodedValue;
  const actualType = encodedValueType(presentValue, envelope);
  const referenceTypeMatches = definition.valueType === "reference" && isReference(presentValue);
  if (definition.valueType && actualType !== definition.valueType && !referenceTypeMatches) {
    violations.push(violation(definition, "type", objectId, `Expected ${definition.valueType}.`, presentValue));
  }
  if (definition.enum && !definition.enum.some((allowed) => encodedKey(presentValue) === encodedKey(encodeConstraintValue(allowed)))) {
    violations.push(violation(definition, "enum", objectId, "Value is not part of the allowed set.", presentValue));
  }
  const comparable = comparableValue(presentValue);
  if (typeof definition.min !== "undefined" && comparable !== undefined && comparable < comparableConstraintValue(definition.min)) {
    violations.push(violation(definition, "min", objectId, `Value is below ${String(definition.min)}.`, presentValue));
  }
  if (typeof definition.max !== "undefined" && comparable !== undefined && comparable > comparableConstraintValue(definition.max)) {
    violations.push(violation(definition, "max", objectId, `Value is above ${String(definition.max)}.`, presentValue));
  }
  if (definition.referenceExists && (!isReference(presentValue) || !envelope.nodes[presentValue.$ref])) {
    violations.push(violation(definition, "referenceExists", objectId, "Reference does not point to an existing object.", presentValue));
  }
}

function validateUnique(
  definition: StorageConstraintDefinition,
  envelope: SerializedEnvelope,
  objectIds: Set<string> | undefined,
  violations: StorageConstraintViolation[],
): void {
  const seen = new Map<string, string>();
  for (const [objectId, node] of objectEntries(envelope)) {
    if (node.kind !== "object" || !matchesDefinitionType(node, definition)) {
      continue;
    }
    const value = node.props[definition.path];
    if (isMissing(value)) {
      continue;
    }
    const presentValue = value as EncodedValue;
    const key = encodedKey(presentValue);
    const conflictObjectId = seen.get(key);
    if (conflictObjectId && (!objectIds || objectIds.has(objectId) || objectIds.has(conflictObjectId))) {
      violations.push({
        ...violation(definition, "unique", objectId, `Value conflicts with object ${conflictObjectId}.`, presentValue),
        conflictObjectId,
      });
      continue;
    }
    seen.set(key, objectId);
  }
}

function objectEntries(envelope: SerializedEnvelope): Array<[string, EncodedNode]> {
  return Object.entries(envelope.nodes);
}

function isTargetObjectEntry(
  objectIds: Set<string> | undefined,
): (entry: [string, EncodedNode]) => entry is [string, Extract<EncodedNode, { kind: "object" }>] {
  return (entry): entry is [string, Extract<EncodedNode, { kind: "object" }>] => {
    const [objectId, node] = entry;
    return (!objectIds || objectIds.has(objectId)) && node.kind === "object";
  };
}

function matchesDefinitionType(node: EncodedNode, definition: StorageConstraintDefinition): boolean {
  return node.kind === "object" && (!definition.type || node.type === definition.type);
}

function violation(
  definition: StorageConstraintDefinition,
  kind: StorageConstraintViolation["kind"],
  objectId: string,
  fallback: string,
  value: EncodedValue | undefined,
): StorageConstraintViolation {
  return {
    name: definition.name ?? `${definition.type ?? "*"}:${definition.path}:${kind}`,
    kind,
    objectId,
    path: definition.path,
    message: definition.message ?? fallback,
    ...(definition.type ? { type: definition.type } : {}),
    ...(typeof value !== "undefined" ? { value } : {}),
  };
}

function isMissing(value: EncodedValue | undefined): boolean {
  return typeof value === "undefined" || value === null || (typeof value === "object" && "$type" in value && value.$type === "undefined");
}

function encodedValueType(value: EncodedValue, envelope: SerializedEnvelope): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return typeof value;
  if (isReference(value)) {
    const node = envelope.nodes[value.$ref];
    if (node?.kind === "array") return "array";
    if (node?.kind === "object" || node?.kind === "map" || node?.kind === "set") return "object";
    return "reference";
  }
  if (value && typeof value === "object" && "$type" in value) return value.$type;
  return "object";
}

function comparableValue(value: EncodedValue): number | string | undefined {
  if (typeof value === "number" || typeof value === "string") return value;
  if (value && typeof value === "object" && "$type" in value && value.$type === "date") return Date.parse(value.value);
  return undefined;
}

function comparableConstraintValue(value: unknown): number | string {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" || typeof value === "string") return value;
  return String(value);
}

function encodeConstraintValue(value: unknown): EncodedValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "undefined") return { $type: "undefined" };
  if (typeof value === "bigint") return { $type: "bigint", value: String(value) };
  if (value instanceof Date) return { $type: "date", value: value.toISOString() };
  return String(value);
}

function encodedKey(value: EncodedValue): string {
  return JSON.stringify(value);
}

function isReference(value: EncodedValue): value is { $ref: string } {
  return Boolean(value && typeof value === "object" && "$ref" in value);
}

function formatConstraintError(result: StorageConstraintValidationResult): string {
  const [first] = result.violations;
  const suffix = result.violations.length > 1 ? ` and ${result.violations.length - 1} more violation(s)` : "";
  return first ? `GraphVault constraint "${first.name}" failed on object ${first.objectId}.${first.path}: ${first.message}${suffix}` : "GraphVault constraint validation failed.";
}
