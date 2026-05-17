import { randomUUID } from "node:crypto";
import { lazy, LazyRef } from "./lazy-ref.js";

/** Segmented list for large arrays whose chunks can be loaded and stored independently. */
export class LazyArrayList<T> {
  private readonly segmentSize: number;
  private length = 0;
  private readonly segments: Array<LazyRef<T[]>> = [];

  /** Creates an empty segmented list with the requested maximum items per lazy segment. */
  constructor(segmentSize = 1_000) {
    if (!Number.isSafeInteger(segmentSize) || segmentSize < 1) {
      throw new RangeError("segmentSize must be a positive safe integer.");
    }
    this.segmentSize = segmentSize;
  }

  /** Returns the logical number of items tracked by the segmented list. */
  get size(): number {
    return this.length;
  }

  /** Appends a value to the final segment, creating a new lazy segment when the current one is full. */
  async push(value: T): Promise<number> {
    const index = this.length;
    const segment = await this.segmentFor(index, true);
    segment[index % this.segmentSize] = value;
    this.length++;
    return this.length;
  }

  /** Loads the containing segment when necessary and returns the item at the requested index. */
  async get(index: number): Promise<T | undefined> {
    this.assertIndex(index);
    const segment = await this.segmentFor(index, false);
    return segment?.[index % this.segmentSize];
  }

  /** Loads or creates the containing segment and replaces the item at the requested index. */
  async set(index: number, value: T): Promise<void> {
    this.assertIndex(index);
    const segment = await this.segmentFor(index, true);
    segment[index % this.segmentSize] = value;
  }

  /** Loads all list segments and returns the list values as a dense array. */
  async toArray(): Promise<T[]> {
    const result: T[] = [];
    for (let index = 0; index < this.length; index++) {
      result.push((await this.get(index)) as T);
    }
    return result;
  }

  /** Drops loaded list segments from memory while keeping persisted segment keys intact. */
  clearLoadedSegments(): void {
    for (const segment of this.segments) {
      segment.clear();
    }
  }

  /** Persists every loaded segment through its LazyRef binding. */
  async storeSegments(): Promise<void> {
    for (const segment of this.segments) {
      await segment.store();
    }
  }

  private async segmentFor(index: number, create: true): Promise<T[]>;
  private async segmentFor(index: number, create: false): Promise<T[] | undefined>;
  private async segmentFor(index: number, create: boolean): Promise<T[] | undefined> {
    const segmentIndex = Math.floor(index / this.segmentSize);
    let ref = this.segments[segmentIndex];
    if (!ref && create) {
      ref = lazy<T[]>(`lazy-array-list/${randomUUID()}`, []);
      this.segments[segmentIndex] = ref;
    }
    return ref?.get();
  }

  private assertIndex(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`Index ${index} is outside the list bounds.`);
    }
  }
}
