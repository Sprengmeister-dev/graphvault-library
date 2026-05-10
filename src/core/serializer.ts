import { Buffer } from "node:buffer";
import { LazyArrayList } from "../lazy/lazy-array-list.js";
import { LazyRef } from "../lazy/lazy-ref.js";
import type {
  ClassConstructor,
  EncodedNode,
  EncodedValue,
  SerializedEnvelope,
  TypedArrayName,
  TypeRegistration,
  TypeDictionaryEntry,
} from "./types.js";
import { UnknownTypeError } from "./errors.js";

interface RegisteredType {
  name: string;
  ctor: ClassConstructor;
  version: number;
  create?: () => object;
  serialize?: (value: object) => Record<string, unknown>;
  hydrate?: (target: object, state: Record<string, unknown>, fromVersion: number) => void;
  migrate?: (state: Record<string, unknown>, fromVersion: number) => Record<string, unknown>;
}

export class TypeRegistry {
  private byName = new Map<string, RegisteredType>();
  private byCtor = new Map<ClassConstructor, RegisteredType>();

  constructor(types: Array<TypeRegistration<any>> = []) {
    this.register({ name: "LazyArrayList", ctor: LazyArrayList });
    for (const type of types) {
      this.register(type);
    }
  }

  register<T extends object>(type: TypeRegistration<T>): void {
    const registered: RegisteredType = {
      name: type.name,
      ctor: type.ctor,
      version: type.version ?? 1,
      ...(type.create ? { create: type.create as () => object } : {}),
      ...(type.serialize ? { serialize: type.serialize as (value: object) => Record<string, unknown> } : {}),
      ...(type.hydrate ? { hydrate: type.hydrate as (target: object, state: Record<string, unknown>, fromVersion: number) => void } : {}),
      ...(type.migrate ? { migrate: type.migrate } : {}),
    };
    this.byName.set(type.name, registered);
    this.byCtor.set(type.ctor, registered);
  }

  byConstructor(value: object): RegisteredType | undefined {
    return this.byCtor.get(value.constructor as ClassConstructor);
  }

  byTypeName(name: string): RegisteredType | undefined {
    return this.byName.get(name);
  }

  entries(): TypeDictionaryEntry[] {
    return Array.from(this.byName.values())
      .map((type) => ({
        name: type.name,
        version: type.version,
        constructorName: type.ctor.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

export class ObjectIdRegistry {
  private readonly ids = new WeakMap<object, string>();
  private nextId = 1;

  idFor(value: object): string {
    const existing = this.ids.get(value);
    if (existing) {
      return existing;
    }
    const id = String(this.nextId++);
    this.ids.set(value, id);
    return id;
  }

  remember(id: string, value: object): void {
    this.ids.set(value, id);
    const numeric = Number(id);
    if (Number.isSafeInteger(numeric) && numeric >= this.nextId) {
      this.nextId = numeric + 1;
    }
  }
}

export class GraphSerializer {
  readonly types: TypeRegistry;
  readonly objectIds: ObjectIdRegistry;

  constructor(types: Array<TypeRegistration<any>> | TypeRegistry = [], objectIds = new ObjectIdRegistry()) {
    this.types = Array.isArray(types) ? new TypeRegistry(types) : types;
    this.objectIds = objectIds;
  }

  serialize(root: unknown): SerializedEnvelope {
    const seen = new Map<object, string>();
    const nodes: Record<string, EncodedNode> = {};
    let nextId = 1;

    const encode = (value: unknown): EncodedValue => {
      if (value === null || typeof value === "string" || typeof value === "boolean") {
        return value;
      }
      if (typeof value === "number") {
        if (Number.isNaN(value)) {
          return { $type: "number", value: "NaN" };
        }
        if (value === Infinity) {
          return { $type: "number", value: "Infinity" };
        }
        if (value === -Infinity) {
          return { $type: "number", value: "-Infinity" };
        }
        if (Object.is(value, -0)) {
          return { $type: "number", value: "-0" };
        }
        return value;
      }
      if (typeof value === "undefined") {
        return { $type: "undefined" };
      }
      if (typeof value === "bigint") {
        return { $type: "bigint", value: value.toString() };
      }
      if (typeof value === "symbol") {
        const globalKey = Symbol.keyFor(value);
        return globalKey === undefined
          ? { $type: "symbol", key: value.description ?? null }
          : { $type: "symbol", global: true, key: globalKey };
      }
      if (value instanceof Date) {
        return { $type: "date", value: value.toISOString() };
      }
      if (Buffer.isBuffer(value)) {
        return { $type: "buffer", value: value.toString("base64") };
      }
      if (value instanceof RegExp) {
        return { $type: "regexp", source: value.source, flags: value.flags };
      }
      if (value instanceof URL) {
        return { $type: "url", value: value.toString() };
      }
      if (value instanceof URLSearchParams) {
        return { $type: "urlsearchparams", value: value.toString() };
      }
      if (value instanceof Error) {
        const cause = (value as Error & { cause?: unknown }).cause;
        const aggregateErrors =
          typeof AggregateError !== "undefined" && value instanceof AggregateError
            ? Array.from(value.errors as Iterable<unknown>, encode)
            : undefined;
        return {
          $type: "error",
          name: value.name,
          message: value.message,
          ...(value.stack ? { stack: value.stack } : {}),
          ...(typeof cause !== "undefined" ? { cause: encode(cause) } : {}),
          ...(aggregateErrors ? { errors: aggregateErrors } : {}),
        };
      }
      if (value instanceof ArrayBuffer) {
        return { $type: "arraybuffer", value: Buffer.from(value).toString("base64") };
      }
      if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
        return { $type: "sharedarraybuffer", value: Buffer.from(value).toString("base64") };
      }
      if (value instanceof DataView) {
        return {
          $type: "dataview",
          value: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
        };
      }
      const typedArrayName = typedArrayNameFor(value);
      if (typedArrayName) {
        const view = value as ArrayBufferView;
        return {
          $type: "typedarray",
          ctor: typedArrayName,
          value: Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64"),
        };
      }
      if (typeof value !== "object") {
        throw new TypeError(`Cannot serialize value of type ${typeof value}.`);
      }

      const existing = seen.get(value);
      if (existing) {
        return { $ref: existing };
      }

      const id = this.objectIds.idFor(value);
      seen.set(value, id);

      if (value instanceof LazyRef) {
        nodes[id] = { kind: "lazy", key: value.key };
        return { $ref: id };
      }
      if (Array.isArray(value)) {
        nodes[id] = { kind: "array", items: value.map(encode) };
        return { $ref: id };
      }
      if (value instanceof Map) {
        nodes[id] = { kind: "map", entries: Array.from(value.entries(), ([key, item]) => [encode(key), encode(item)]) };
        return { $ref: id };
      }
      if (value instanceof Set) {
        nodes[id] = { kind: "set", items: Array.from(value.values(), encode) };
        return { $ref: id };
      }

      const registration = this.types.byConstructor(value);
      const state = registration?.serialize ? registration.serialize(value) : (value as Record<string, unknown>);
      const props: Record<string, EncodedValue> = {};
      for (const key of Object.keys(state)) {
        props[key] = encode(state[key]);
      }
      const symbolProps = Object.getOwnPropertySymbols(state)
        .filter((key) => Object.prototype.propertyIsEnumerable.call(state, key))
        .map((key) => [encode(key), encode((state as Record<symbol, unknown>)[key])] as [EncodedValue, EncodedValue]);
      nodes[id] = {
        kind: "object",
        ...(registration ? { type: registration.name, version: registration.version } : {}),
        props,
        ...(symbolProps.length > 0 ? { symbolProps } : {}),
      };
      return { $ref: id };
    };

    return {
      format: "graphvault",
      version: 1,
      createdAt: new Date().toISOString(),
      root: encode(root),
      nodes,
    };
  }

  deserialize<TRoot>(envelope: SerializedEnvelope): TRoot {
    const cache = new Map<string, unknown>();
    const hydrated = new Set<string>();
    const hydrating = new Set<string>();

    const createShell = (id: string): unknown => {
      const cached = cache.get(id);
      if (cached) {
        return cached;
      }
      const node = envelope.nodes[id];
      if (!node) {
        throw new UnknownTypeError(`Missing serialized node "${id}".`);
      }
      let shell: unknown;
      switch (node.kind) {
        case "array":
          shell = [];
          break;
        case "map":
          shell = new Map();
          break;
        case "set":
          shell = new Set();
          break;
        case "lazy":
          shell = LazyRef.unloaded(node.key);
          break;
        case "object": {
          if (node.type) {
            const registration = this.types.byTypeName(node.type);
            if (!registration) {
              throw new UnknownTypeError(`Type "${node.type}" is not registered.`);
            }
            shell = registration.create ? registration.create() : (Object.create(registration.ctor.prototype) as object);
          } else {
            shell = {};
          }
          break;
        }
      }
      cache.set(id, shell);
      if (shell && typeof shell === "object") {
        this.objectIds.remember(id, shell);
      }
      return shell;
    };

    const decode = (value: EncodedValue): unknown => {
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
      }
      if ("$type" in value) {
        switch (value.$type) {
          case "undefined":
            return undefined;
          case "number":
            return specialNumberFrom(value.value);
          case "bigint":
            return BigInt(value.value);
          case "symbol":
            return value.global ? Symbol.for(value.key ?? "") : Symbol(value.key ?? undefined);
          case "date":
            return new Date(value.value);
          case "buffer":
            return Buffer.from(value.value, "base64");
          case "regexp":
            return new RegExp(value.source, value.flags);
          case "url":
            return new URL(value.value);
          case "urlsearchparams":
            return new URLSearchParams(value.value);
          case "error": {
            const error = createErrorFromEncoded(
              value.name,
              value.message,
              "cause" in value ? decode(value.cause as EncodedValue) : undefined,
              value.errors?.map(decode),
            );
            if (value.stack) {
              error.stack = value.stack;
            }
            return error;
          }
          case "arraybuffer": {
            const buffer = Buffer.from(value.value, "base64");
            return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
          }
          case "sharedarraybuffer": {
            const buffer = Buffer.from(value.value, "base64");
            const shared = new SharedArrayBuffer(buffer.byteLength);
            new Uint8Array(shared).set(buffer);
            return shared;
          }
          case "dataview": {
            const buffer = Buffer.from(value.value, "base64");
            return new DataView(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
          }
          case "typedarray":
            return typedArrayFrom(value.ctor, Buffer.from(value.value, "base64"));
        }
      }
      return hydrate(value.$ref);
    };

    const hydrate = (id: string): unknown => {
      const shell = createShell(id);
      if (hydrated.has(id) || hydrating.has(id)) {
        return shell;
      }
      hydrating.add(id);
      const node = envelope.nodes[id] as EncodedNode;
      switch (node.kind) {
        case "array":
          (shell as unknown[]).splice(0, 0, ...node.items.map(decode));
          hydrating.delete(id);
          hydrated.add(id);
          return shell;
        case "map":
          for (const [key, value] of node.entries) {
            (shell as Map<unknown, unknown>).set(decode(key), decode(value));
          }
          hydrating.delete(id);
          hydrated.add(id);
          return shell;
        case "set":
          for (const item of node.items) {
            (shell as Set<unknown>).add(decode(item));
          }
          hydrating.delete(id);
          hydrated.add(id);
          return shell;
        case "lazy":
          hydrating.delete(id);
          hydrated.add(id);
          return shell;
        case "object": {
          let props = Object.fromEntries(Object.entries(node.props).map(([key, value]) => [key, decode(value)]));
          if (node.type) {
            const registration = this.types.byTypeName(node.type);
            const fromVersion = node.version ?? 1;
            if (registration?.migrate && fromVersion < registration.version) {
              props = registration.migrate(props, fromVersion);
            }
          }
          if (node.type) {
            const registration = this.types.byTypeName(node.type);
            if (registration?.hydrate) {
              registration.hydrate(shell as object, props, node.version ?? 1);
            } else {
              Object.assign(shell as object, props);
            }
          } else {
            Object.assign(shell as object, props);
          }
          for (const [key, value] of node.symbolProps ?? []) {
            const symbolKey = decode(key);
            if (typeof symbolKey !== "symbol") {
              throw new UnknownTypeError("Serialized symbol property key did not decode to a symbol.");
            }
            (shell as Record<symbol, unknown>)[symbolKey] = decode(value);
          }
          hydrating.delete(id);
          hydrated.add(id);
          return shell;
        }
      }
    };

    return decode(envelope.root) as TRoot;
  }
}

function specialNumberFrom(value: "NaN" | "Infinity" | "-Infinity" | "-0"): number {
  switch (value) {
    case "NaN":
      return Number.NaN;
    case "Infinity":
      return Infinity;
    case "-Infinity":
      return -Infinity;
    case "-0":
      return -0;
  }
}

function createErrorFromEncoded(name: string, message: string, cause?: unknown, errors?: unknown[]): Error {
  const options = typeof cause !== "undefined" ? { cause } : undefined;
  if (name === "AggregateError" && typeof AggregateError !== "undefined") {
    return new AggregateError(errors ?? [], message, options);
  }
  const constructors: Record<string, new (message?: string, options?: ErrorOptions) => Error> = {
    Error,
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URIError,
  };
  const ctor = constructors[name] ?? Error;
  const error = new ctor(message, options);
  error.name = name;
  return error;
}

function typedArrayNameFor(value: unknown): TypedArrayName | undefined {
  if (value instanceof Int8Array) return "Int8Array";
  if (value instanceof Uint8Array) return "Uint8Array";
  if (value instanceof Uint8ClampedArray) return "Uint8ClampedArray";
  if (value instanceof Int16Array) return "Int16Array";
  if (value instanceof Uint16Array) return "Uint16Array";
  if (value instanceof Int32Array) return "Int32Array";
  if (value instanceof Uint32Array) return "Uint32Array";
  if (value instanceof Float32Array) return "Float32Array";
  if (value instanceof Float64Array) return "Float64Array";
  if (typeof BigInt64Array !== "undefined" && value instanceof BigInt64Array) return "BigInt64Array";
  if (typeof BigUint64Array !== "undefined" && value instanceof BigUint64Array) return "BigUint64Array";
  return undefined;
}

function typedArrayFrom(name: TypedArrayName, buffer: Buffer): ArrayBufferView {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  switch (name) {
    case "Int8Array":
      return new Int8Array(arrayBuffer);
    case "Uint8Array":
      return new Uint8Array(arrayBuffer);
    case "Uint8ClampedArray":
      return new Uint8ClampedArray(arrayBuffer);
    case "Int16Array":
      return new Int16Array(arrayBuffer);
    case "Uint16Array":
      return new Uint16Array(arrayBuffer);
    case "Int32Array":
      return new Int32Array(arrayBuffer);
    case "Uint32Array":
      return new Uint32Array(arrayBuffer);
    case "Float32Array":
      return new Float32Array(arrayBuffer);
    case "Float64Array":
      return new Float64Array(arrayBuffer);
    case "BigInt64Array":
      return new BigInt64Array(arrayBuffer);
    case "BigUint64Array":
      return new BigUint64Array(arrayBuffer);
  }
}
