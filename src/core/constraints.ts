import type {
  StorageConstraintDefinition,
  StorageConstraintValueType,
  TypeRegistration,
} from "./types.js";

/** Field-level constraint annotation accepted by GraphVault constraint decorators. */
export interface GraphVaultConstraintOptions {
  required?: boolean;
  valueType?: StorageConstraintValueType;
  enum?: unknown[];
  min?: unknown;
  max?: unknown;
  unique?: boolean;
  referenceExists?: boolean;
  message?: string;
}

type DecoratorContext = {
  kind: string;
  name: string | symbol;
  static?: boolean;
  addInitializer?: (initializer: (this: object) => void) => void;
};

const constraints = new WeakMap<object, Map<PropertyKey, GraphVaultConstraintOptions>>();

/** Adds one or more storage constraints to a class field. */
export function GraphVaultConstraint(options: GraphVaultConstraintOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol | DecoratorContext) => {
    if (isDecoratorContext(propertyKey)) {
      registerStandardConstraintDecorator(target, propertyKey, options);
      return;
    }
    registerGraphVaultConstraint(target, propertyKey, options);
  };
}

/** Requires the decorated field to be present and non-null on every committed object. */
export function GraphVaultRequired(message?: string): PropertyDecorator {
  return GraphVaultConstraint({ required: true, ...(message ? { message } : {}) });
}

/** Requires the decorated field to have the supplied persisted value type. */
export function GraphVaultType(valueType: StorageConstraintValueType, message?: string): PropertyDecorator {
  return GraphVaultConstraint({ valueType, ...(message ? { message } : {}) });
}

/** Requires the decorated field to match one of the supplied values. */
export function GraphVaultEnum(values: unknown[], message?: string): PropertyDecorator {
  return GraphVaultConstraint({ enum: values, ...(message ? { message } : {}) });
}

/** Requires the decorated field to be greater than or equal to the supplied value. */
export function GraphVaultMin(value: unknown, message?: string): PropertyDecorator {
  return GraphVaultConstraint({ min: value, ...(message ? { message } : {}) });
}

/** Requires the decorated field to be less than or equal to the supplied value. */
export function GraphVaultMax(value: unknown, message?: string): PropertyDecorator {
  return GraphVaultConstraint({ max: value, ...(message ? { message } : {}) });
}

/** Requires the decorated field value to be unique across all objects of the same registered type. */
export function GraphVaultUnique(message?: string): PropertyDecorator {
  return GraphVaultConstraint({ unique: true, ...(message ? { message } : {}) });
}

/** Requires the decorated field to point to an existing object when it contains a reference. */
export function GraphVaultReferenceExists(message?: string): PropertyDecorator {
  return GraphVaultConstraint({ referenceExists: true, ...(message ? { message } : {}) });
}

/** Registers constraint metadata for custom decorator integrations. */
export function registerGraphVaultConstraint(target: object, propertyKey: PropertyKey, annotation: GraphVaultConstraintOptions): void {
  const fields = constraints.get(target) ?? new Map<PropertyKey, GraphVaultConstraintOptions>();
  fields.set(propertyKey, mergeConstraintOptions(fields.get(propertyKey), annotation));
  constraints.set(target, fields);
}

/** Returns constraint metadata registered directly on a prototype or any of its parent prototypes. */
export function graphVaultConstraintsForPrototype(prototype: object): Map<PropertyKey, GraphVaultConstraintOptions> {
  const merged = new Map<PropertyKey, GraphVaultConstraintOptions>();
  let current: object | null = prototype;
  while (current) {
    for (const [key, annotation] of constraints.get(current) ?? []) {
      merged.set(key, mergeConstraintOptions(merged.get(key), annotation));
    }
    current = Object.getPrototypeOf(current);
  }
  return merged;
}

/** Converts annotated class fields on registered GraphVault types into storage constraint definitions. */
export function graphVaultConstraintDefinitionsForTypes(types: Array<TypeRegistration<any>> = []): StorageConstraintDefinition[] {
  const definitions: StorageConstraintDefinition[] = [];
  for (const type of types) {
    for (const [propertyKey, annotation] of graphVaultConstraintsForPrototype(type.ctor.prototype)) {
      if (typeof propertyKey !== "string") {
        continue;
      }
      definitions.push({
        name: `${type.name}.${propertyKey}`,
        type: type.name,
        path: propertyKey,
        ...annotation,
      });
    }
  }
  return definitions;
}

function registerStandardConstraintDecorator(
  _target: object,
  context: DecoratorContext,
  annotation: GraphVaultConstraintOptions,
): void {
  if (context.kind !== "field" && context.kind !== "accessor") {
    throw new TypeError("GraphVault constraint decorators can only decorate fields or accessors.");
  }
  context.addInitializer?.(function initializeGraphVaultConstraint(this: object) {
    registerGraphVaultConstraint(context.static ? this : Object.getPrototypeOf(this), context.name, annotation);
  });
}

function mergeConstraintOptions(
  existing: GraphVaultConstraintOptions | undefined,
  next: GraphVaultConstraintOptions,
): GraphVaultConstraintOptions {
  const merged: GraphVaultConstraintOptions = {
    ...existing,
    ...next,
    ...(existing?.enum || next.enum ? { enum: [...(existing?.enum ?? []), ...(next.enum ?? [])] } : {}),
  };
  if (existing?.required || next.required) merged.required = true;
  if (existing?.unique || next.unique) merged.unique = true;
  if (existing?.referenceExists || next.referenceExists) merged.referenceExists = true;
  return merged;
}

function isDecoratorContext(value: unknown): value is DecoratorContext {
  return Boolean(value && typeof value === "object" && "kind" in value && "name" in value);
}
