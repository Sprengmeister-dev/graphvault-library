import { LazyRef } from "../lazy/lazy-ref.js";
import type { GraphSerializer } from "../core/serializer.js";
import type { EagerFieldEvaluator, SerializedEnvelope } from "../core/types.js";

/** Runs the public collectObjectIdsForTargets helper. */
export function collectObjectIdsForTargets(input: {
  envelope: SerializedEnvelope;
  targets: readonly unknown[];
  serializer: GraphSerializer;
  persistedObjectIds: ReadonlySet<string>;
  eagerFieldEvaluator?: EagerFieldEvaluator;
}): string[] {
  const requested = new Set<string>();
  const seen = new Set<unknown>();
  const visitValue = (value: unknown, force = false): void => {
    collectValue({ ...input, requested, seen, value, force, visitValue });
  };
  for (const target of input.targets) {
    visitValue(target, true);
  }
  addRootFallback(input.envelope, requested);
  return Array.from(requested).sort((a, b) => Number(a) - Number(b));
}

function collectValue(input: {
  envelope: SerializedEnvelope;
  serializer: GraphSerializer;
  persistedObjectIds: ReadonlySet<string>;
  eagerFieldEvaluator?: EagerFieldEvaluator;
  requested: Set<string>;
  seen: Set<unknown>;
  value: unknown;
  force: boolean;
  visitValue: (value: unknown, force?: boolean) => void;
}): void {
  if (!input.value || typeof input.value !== "object" || input.seen.has(input.value)) {
    return;
  }
  const value = input.value;
  input.seen.add(value);
  addIfRequested({ ...input, value });
  if (input.value instanceof LazyRef) {
    return;
  }
  visitChildren({ ...input, value });
}

function addIfRequested(input: {
  envelope: SerializedEnvelope;
  serializer: GraphSerializer;
  persistedObjectIds: ReadonlySet<string>;
  requested: Set<string>;
  value: object;
  force: boolean;
}): void {
  const id = input.serializer.objectIds.idFor(input.value);
  if (input.envelope.nodes[id] && (input.force || !input.persistedObjectIds.has(id))) {
    input.requested.add(id);
  }
}

function visitChildren(input: {
  value: object;
  eagerFieldEvaluator?: EagerFieldEvaluator;
  visitValue: (value: unknown, force?: boolean) => void;
}): void {
  if (input.value instanceof Map) {
    for (const [key, item] of input.value) {
      input.visitValue(key);
      input.visitValue(item);
    }
    return;
  }
  if (input.value instanceof Set || Array.isArray(input.value)) {
    for (const item of input.value) {
      input.visitValue(item);
    }
    return;
  }
  for (const [fieldName, item] of Object.entries(input.value)) {
    input.visitValue(item, Boolean(input.eagerFieldEvaluator?.({ owner: input.value, fieldName, value: item })));
  }
}

function addRootFallback(envelope: SerializedEnvelope, requested: Set<string>): void {
  if (requested.size === 0 && envelope.root && typeof envelope.root === "object" && "$ref" in envelope.root) {
    requested.add(envelope.root.$ref);
  }
}
