import { LazyRef } from "../lazy/lazy-ref.js";

/** Binds LazyRef instances in a root graph to the manager's load and store callbacks. */
export function bindStorageLazyRefs(
  value: unknown,
  handlers: { load: <T>(key: string) => Promise<T>; store: <T>(key: string, value: T) => Promise<void> },
  seen = new Set<object>(),
): void {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (value instanceof LazyRef) {
    value.bind(handlers.load, handlers.store);
    return;
  }
  if (value instanceof Map) {
    for (const [key, item] of value) {
      bindStorageLazyRefs(key, handlers, seen);
      bindStorageLazyRefs(item, handlers, seen);
    }
    return;
  }
  if (value instanceof Set || Array.isArray(value)) {
    for (const item of value) {
      bindStorageLazyRefs(item, handlers, seen);
    }
    return;
  }
  for (const item of Object.values(value)) {
    bindStorageLazyRefs(item, handlers, seen);
  }
}

export async function storeLoadedStorageLazyRefs(
  value: unknown,
  seen = new Set<object>(),
): Promise<void> {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (value instanceof LazyRef) {
    if (value.isLoaded()) {
      await value.store();
    }
    return;
  }
  if (value instanceof Map) {
    for (const [key, item] of value) {
      await storeLoadedStorageLazyRefs(key, seen);
      await storeLoadedStorageLazyRefs(item, seen);
    }
    return;
  }
  if (value instanceof Set || Array.isArray(value)) {
    for (const item of value) {
      await storeLoadedStorageLazyRefs(item, seen);
    }
    return;
  }
  for (const item of Object.values(value)) {
    await storeLoadedStorageLazyRefs(item, seen);
  }
}
