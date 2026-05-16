import type { EncodedNode, EncodedValue, ParentIndexRecord, SerializedEnvelope } from "../core/types.js";

/** Runs the public buildParentIndexRecord helper. */
export function buildParentIndexRecord(envelope: SerializedEnvelope, transactionId: number): ParentIndexRecord {
  const parents: ParentIndexRecord["parents"] = {};
  for (const [objectId, node] of Object.entries(envelope.nodes)) {
    visitReferences(node, (path, childObjectId) => {
      parents[childObjectId] ??= [];
      parents[childObjectId].push({ parentObjectId: objectId, path });
    });
  }
  return {
    format: "graphvault-parent-index",
    version: 1,
    transactionId,
    ...(envelope.root && typeof envelope.root === "object" && "$ref" in envelope.root ? { rootObjectId: envelope.root.$ref } : {}),
    parents,
  };
}

function visitReferences(node: EncodedNode, visit: (path: string, objectId: string) => void): void {
  visitNode(node, (path, value) => {
    if (value && typeof value === "object" && "$ref" in value) {
      visit(path, value.$ref);
    }
  });
}

function visitNode(node: EncodedNode, visit: (path: string, value: EncodedValue) => void): void {
  if (node.kind === "array" || node.kind === "set") {
    node.items.forEach((value, index) => visit(`[${index}]`, value));
  } else if (node.kind === "map") {
    node.entries.forEach(([key, value], index) => {
      visit(`entries[${index}].key`, key);
      visit(`entries[${index}].value`, value);
    });
  } else if (node.kind === "object") {
    for (const [key, value] of Object.entries(node.props)) {
      visit(key, value);
    }
    node.symbolProps?.forEach(([key, value], index) => {
      visit(`symbolProps[${index}].key`, key);
      visit(`symbolProps[${index}].value`, value);
    });
  }
}
