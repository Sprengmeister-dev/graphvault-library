import type {
  EncodedNode,
  EncodedValue,
  ObjectRecord,
  SerializedEnvelope,
  StorageManifest,
  SubtreeLoadOptions,
  SubtreeLoadResult,
  SubtreeReference,
} from "../core/types.js";

/** Minimal reader contract needed to load bounded subtrees from persisted object records. */
export interface ManifestSubtreeReader {
  /** Reads one persisted object record by object ID and optional transaction version. */
  readObjectRecord(objectId: string, transactionId?: number): Promise<ObjectRecord>;
}

export async function loadSubtreeFromManifest(
  reader: ManifestSubtreeReader,
  manifest: StorageManifest,
  options: SubtreeLoadOptions = {},
): Promise<SubtreeLoadResult> {
  const depth = normalizeDepth(options.depth);
  const rootObjectId = options.rootObjectId ?? objectIdFromRef(manifest.root);
  const baseEnvelope = {
    format: "graphvault" as const,
    version: 1 as const,
    createdAt: manifest.createdAt,
    root: rootObjectId ? { $ref: rootObjectId } : manifest.root,
  };
  if (!rootObjectId) {
    return {
      ...baseEnvelopeResult(baseEnvelope, manifest.transactionId, depth),
      complete: true,
    };
  }

  const objectVersions = new Map(Object.entries(manifest.objectVersions ?? {}).map(([objectId, transactionId]) => [objectId, transactionId]));
  const knownObjectIds = new Set(manifest.objectIds);
  if (!knownObjectIds.has(rootObjectId)) {
    throw new Error(`Cannot load subtree: object "${rootObjectId}" is not present in the current manifest.`);
  }

  return loadSubtree({
    depth,
    transactionId: manifest.transactionId,
    baseEnvelope,
    rootObjectId,
    readNode: async (objectId) => {
      const record = await reader.readObjectRecord(objectId, objectVersions.get(objectId) ?? manifest.transactionId);
      return record.node;
    },
    hasObject: (objectId) => knownObjectIds.has(objectId),
  });
}

/** Builds a bounded subtree envelope directly from an already serialized root graph. */
export function loadSubtreeFromEnvelope(envelope: SerializedEnvelope, options: SubtreeLoadOptions = {}, transactionId = 0): SubtreeLoadResult {
  const depth = normalizeDepth(options.depth);
  const rootObjectId = options.rootObjectId ?? objectIdFromRef(envelope.root);
  const baseEnvelope = {
    format: "graphvault" as const,
    version: 1 as const,
    createdAt: envelope.createdAt,
    root: rootObjectId ? { $ref: rootObjectId } : envelope.root,
  };
  if (!rootObjectId) {
    return {
      ...baseEnvelopeResult(baseEnvelope, transactionId, depth),
      complete: true,
    };
  }
  if (!envelope.nodes[rootObjectId]) {
    throw new Error(`Cannot load subtree: object "${rootObjectId}" is not present in the envelope.`);
  }

  const nodes: Record<string, EncodedNode> = {};
  const queue: Array<{ objectId: string; depth: number }> = [{ objectId: rootObjectId, depth: 0 }];
  const queued = new Set([rootObjectId]);
  const truncatedCandidates: SubtreeReference[] = [];

  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (!current) {
      continue;
    }
    const node = envelope.nodes[current.objectId];
    if (!node) {
      continue;
    }
    nodes[current.objectId] = node;
    enqueueReferences(node, current.objectId, current.depth, depth, queued, queue, truncatedCandidates, (objectId) =>
      Boolean(envelope.nodes[objectId]),
    );
  }

  return buildResult(baseEnvelope, nodes, transactionId, depth, rootObjectId, truncatedCandidates);
}

async function loadSubtree(options: {
  depth: number;
  transactionId: number;
  baseEnvelope: Omit<SerializedEnvelope, "nodes">;
  rootObjectId: string;
  readNode: (objectId: string) => Promise<EncodedNode>;
  hasObject: (objectId: string) => boolean;
}): Promise<SubtreeLoadResult> {
  const nodes: Record<string, EncodedNode> = {};
  const queue: Array<{ objectId: string; depth: number }> = [{ objectId: options.rootObjectId, depth: 0 }];
  const queued = new Set([options.rootObjectId]);
  const truncatedCandidates: SubtreeReference[] = [];

  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (!current) {
      continue;
    }
    const node = await options.readNode(current.objectId);
    nodes[current.objectId] = node;
    enqueueReferences(node, current.objectId, current.depth, options.depth, queued, queue, truncatedCandidates, options.hasObject);
  }

  return buildResult(options.baseEnvelope, nodes, options.transactionId, options.depth, options.rootObjectId, truncatedCandidates);
}

function enqueueReferences(
  node: EncodedNode,
  fromObjectId: string,
  currentDepth: number,
  maxDepth: number,
  queued: Set<string>,
  queue: Array<{ objectId: string; depth: number }>,
  truncatedCandidates: SubtreeReference[],
  hasObject: (objectId: string) => boolean,
): void {
  for (const reference of referencesFromNode(node, fromObjectId, currentDepth + 1)) {
    if (!hasObject(reference.toObjectId)) {
      truncatedCandidates.push(reference);
      continue;
    }
    if (currentDepth < maxDepth) {
      if (!queued.has(reference.toObjectId)) {
        queued.add(reference.toObjectId);
        queue.push({ objectId: reference.toObjectId, depth: currentDepth + 1 });
      }
    } else {
      truncatedCandidates.push(reference);
    }
  }
}

function referencesFromNode(node: EncodedNode, fromObjectId: string, depth: number): SubtreeReference[] {
  const references: SubtreeReference[] = [];
  visitEncodedNode(node, (path, value) => {
    const toObjectId = objectIdFromRef(value);
    if (toObjectId) {
      references.push({ fromObjectId, toObjectId, path, depth });
    }
  });
  return references;
}

function buildResult(
  baseEnvelope: Omit<SerializedEnvelope, "nodes">,
  nodes: Record<string, EncodedNode>,
  transactionId: number,
  depth: number,
  rootObjectId: string,
  truncatedCandidates: SubtreeReference[],
): SubtreeLoadResult {
  const truncatedReferences = truncatedCandidates.filter((reference) => !nodes[reference.toObjectId]);
  return {
    envelope: { ...baseEnvelope, nodes },
    transactionId,
    depth,
    complete: truncatedReferences.length === 0,
    objectIds: Object.keys(nodes),
    truncatedReferences,
    rootObjectId,
  };
}

function baseEnvelopeResult(baseEnvelope: Omit<SerializedEnvelope, "nodes">, transactionId: number, depth: number): Omit<SubtreeLoadResult, "complete"> {
  return {
    envelope: { ...baseEnvelope, nodes: {} },
    transactionId,
    depth,
    objectIds: [],
    truncatedReferences: [],
  };
}

function objectIdFromRef(value: EncodedValue): string | undefined {
  return value && typeof value === "object" && "$ref" in value ? value.$ref : undefined;
}

function normalizeDepth(depth = 1): number {
  if (!Number.isInteger(depth) || depth < 0) {
    throw new TypeError("Subtree depth must be a non-negative integer.");
  }
  return depth;
}

function visitEncodedNode(node: EncodedNode, visit: (path: string, value: EncodedValue) => void): void {
  if (node.kind === "array" || node.kind === "set") {
    node.items.forEach((value, index) => visit(`[${index}]`, value));
    return;
  }
  if (node.kind === "map") {
    node.entries.forEach(([key, value], index) => {
      visit(`entries[${index}].key`, key);
      visit(`entries[${index}].value`, value);
    });
    return;
  }
  if (node.kind === "object") {
    for (const [key, value] of Object.entries(node.props)) {
      visit(key, value);
    }
    node.symbolProps?.forEach(([key, value], index) => {
      visit(`symbolProps[${index}].key`, key);
      visit(`symbolProps[${index}].value`, value);
    });
  }
}
