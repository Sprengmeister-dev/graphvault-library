import type { EncodedNode, EncodedValue, SerializedEnvelope } from "./types.js";
import type { GvqlGraphEdge, GvqlGraphIndex, GvqlGraphNode } from "./gvql-types.js";

export function buildGvqlGraphIndex(envelope: SerializedEnvelope): GvqlGraphIndex {
  const nodes = new Map<string, GvqlGraphNode>();
  const byType = new Map<string, string[]>();
  const outgoing = new Map<string, GvqlGraphEdge[]>();
  const incoming = new Map<string, GvqlGraphEdge[]>();

  for (const [objectId, encoded] of Object.entries(envelope.nodes)) {
    const node: GvqlGraphNode = {
      objectId,
      kind: encoded.kind,
      ...(encoded.kind === "object" && encoded.type ? { type: encoded.type } : {}),
    };
    nodes.set(objectId, node);
    if (node.type) {
      const typed = byType.get(node.type) ?? [];
      typed.push(objectId);
      byType.set(node.type, typed);
    }

    for (const edge of referencedEdges(objectId, encoded)) {
      const fromList = outgoing.get(edge.from) ?? [];
      fromList.push(edge);
      outgoing.set(edge.from, fromList);
      const toList = incoming.get(edge.to) ?? [];
      toList.push(edge);
      incoming.set(edge.to, toList);
    }
  }

  return { envelope, nodes, byType, outgoing, incoming };
}

export function referencedEdges(from: string, node: EncodedNode): GvqlGraphEdge[] {
  const edges: GvqlGraphEdge[] = [];
  visitEncodedNode(node, (path, value) => {
    if (value && typeof value === "object" && "$ref" in value) {
      edges.push({ from, to: value.$ref, path, label: edgeLabel(path) });
    }
  });
  return edges;
}

export function visitEncodedNode(node: EncodedNode, visit: (path: string, value: EncodedValue) => void): void {
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

function edgeLabel(path: string): string {
  const bracket = path.indexOf("[");
  const dot = path.indexOf(".");
  const end = Math.min(...[bracket, dot].filter((value) => value >= 0));
  return Number.isFinite(end) ? path.slice(0, end) : path;
}
