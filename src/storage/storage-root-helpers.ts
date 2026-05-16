/** Runs the public isIterable helper. */
export function isIterable(value: unknown): value is Iterable<unknown> {
  return Boolean(value) && typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function";
}

/** Runs the public replaceObjectContents helper. */
export function replaceObjectContents(target: object, source: object): void {
  if (Array.isArray(target) && Array.isArray(source)) {
    target.splice(0, target.length, ...source);
    return;
  }
  if (target instanceof Map && source instanceof Map) {
    target.clear();
    for (const [key, value] of source) {
      target.set(key, value);
    }
    return;
  }
  if (target instanceof Set && source instanceof Set) {
    target.clear();
    for (const value of source) {
      target.add(value);
    }
    return;
  }
  for (const key of Object.keys(target)) {
    delete (target as Record<string, unknown>)[key];
  }
  Object.assign(target, source);
}
