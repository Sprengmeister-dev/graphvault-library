/** Configures which persistence phases should ignore an annotated field. */
export interface GraphVaultIgnoreOptions {
  /** Exclude the annotated field from serialized envelopes. Defaults to true. */
  save?: boolean;
  /** Ignore stored values for the annotated field during deserialization. Defaults to true. */
  load?: boolean;
}

/** Records the save/load behavior attached to one annotated field. */
export interface GraphVaultFieldAnnotation {
  /** Whether the field is skipped while storing objects. */
  save: boolean;
  /** Whether the field is skipped while loading objects. */
  load: boolean;
}

type DecoratorContext = {
  kind: string;
  name: string | symbol;
  static?: boolean;
  addInitializer?: (initializer: (this: object) => void) => void;
};

const annotations = new WeakMap<object, Map<PropertyKey, GraphVaultFieldAnnotation>>();

/** Marks a class field as ignored while saving, loading, or both. */
export function GraphVaultIgnore(options: GraphVaultIgnoreOptions = {}): PropertyDecorator {
  const annotation = {
    save: options.save ?? true,
    load: options.load ?? true,
  };
  return (target: object, propertyKey: string | symbol | DecoratorContext) => {
    if (isDecoratorContext(propertyKey)) {
      registerStandardDecorator(target, propertyKey, annotation);
      return;
    }
    registerGraphVaultFieldAnnotation(target, propertyKey, annotation);
  };
}

/** Marks a class field as omitted from new commits while older stored values can still load. */
export function GraphVaultIgnoreSave(): PropertyDecorator {
  return GraphVaultIgnore({ save: true, load: false });
}

/** Marks a class field as skipped during loading while commits may still contain it. */
export function GraphVaultIgnoreLoad(): PropertyDecorator {
  return GraphVaultIgnore({ save: false, load: true });
}

/** Registers field persistence metadata for custom decorator integrations. */
export function registerGraphVaultFieldAnnotation(
  target: object,
  propertyKey: PropertyKey,
  annotation: GraphVaultFieldAnnotation,
): void {
  const fields = annotations.get(target) ?? new Map<PropertyKey, GraphVaultFieldAnnotation>();
  const existing = fields.get(propertyKey) ?? { save: false, load: false };
  fields.set(propertyKey, { save: existing.save || annotation.save, load: existing.load || annotation.load });
  annotations.set(target, fields);
}

/** Returns true when a field should be skipped for the requested persistence phase. */
export function shouldIgnoreGraphVaultField(owner: object, propertyKey: PropertyKey, phase: keyof GraphVaultFieldAnnotation): boolean {
  let current: object | null = owner;
  while (current) {
    if (annotations.get(current)?.get(propertyKey)?.[phase]) {
      return true;
    }
    current = Object.getPrototypeOf(current);
  }
  return false;
}

function registerStandardDecorator(
  _target: object,
  context: DecoratorContext,
  annotation: GraphVaultFieldAnnotation,
): void {
  if (context.kind !== "field" && context.kind !== "accessor") {
    throw new TypeError("@GraphVaultIgnore can only decorate fields or accessors.");
  }
  context.addInitializer?.(function initializeGraphVaultFieldAnnotation(this: object) {
    registerGraphVaultFieldAnnotation(context.static ? this : Object.getPrototypeOf(this), context.name, annotation);
  });
}

function isDecoratorContext(value: unknown): value is DecoratorContext {
  return Boolean(value && typeof value === "object" && "kind" in value && "name" in value);
}
