import type { ComponentConfig, Draft } from "@rpp/protocol";
import type { ComponentKey, SourceInfo } from "@rpp/machine-view";
import { keyOf } from "./edits";
import type { NodeKey, SourceTopology, TopologyNodeView } from "./topology";

/**
 * The draft's components as the configurator lists them: per PLC along its topology (ADR 0023), each component under
 * the node that stands for it.
 */

/** A component in the tree. */
export interface TreeComponent {
  key: ComponentKey;
  id: number;
  name: string;
  /** False for a component only its PLC has: the draft can take it over. */
  inDraft: boolean;
}

/** A topology node with the components it stands for and the nodes in use below it. */
export interface TreeNode {
  node: NodeKey;
  name: string;
  kind: string;
  components: TreeComponent[];
  children: TreeNode[];
}

/** One PLC's part of the tree. */
export interface SourceTree {
  sourceId: string;
  name: string;
  /** The root node with every node in use below it; empty without a topology. */
  nodes: TreeNode[];
  /** The nodes not in use, with the components they stand for. */
  notInUse: TreeNode[];
  /** The components of a PLC without a topology, in a flat list. */
  components: TreeComponent[];
}

/** The draft's components as the component list shows them: per PLC along its topology, then those of no node. */
export interface DraftTree {
  sources: SourceTree[];
  /** The components no node stands for and no PLC without a topology lists: the draft's, then those only in a PLC. */
  withoutNode: TreeComponent[];
}

/**
 * The tree of the draft's components over the PLCs the gateway reads and their topologies; `plcOnly` are the PLCs'
 * components the draft has not.
 */
export function draftTree(
  draft: Draft,
  plcSources: readonly SourceInfo[],
  topologies: readonly SourceTopology[],
  plcOnly: readonly ComponentConfig[],
): DraftTree {
  const inDraft = new Map<ComponentKey, ComponentConfig>(draft.components.map((c) => [keyOf(c), c]));
  const inPlc = new Map<ComponentKey, ComponentConfig>(plcOnly.map((c) => [keyOf(c), c]));
  const placed = new Set<ComponentKey>();
  const component = (key: ComponentKey): TreeComponent[] => {
    const own = inDraft.get(key);
    const c = own ?? inPlc.get(key);
    if (!c) return [];
    placed.add(key);
    return [{ key, id: c.id, name: c.name, inDraft: own !== undefined }];
  };
  const node = (sourceId: string, n: TopologyNodeView): TreeNode => ({
    node: { sourceId, id: n.id },
    name: n.name,
    kind: n.kind,
    components: n.components.flatMap(component),
    children: n.children.map((child) => node(sourceId, child)),
  });
  const sources = plcSources.map((s): SourceTree => {
    const t = topologies.find((x) => x.sourceId === s.sourceId);
    if (!t) {
      const keys = [...draft.components, ...plcOnly].filter((c) => c.sourceId === s.sourceId).map(keyOf);
      return { sourceId: s.sourceId, name: s.name, nodes: [], notInUse: [], components: keys.flatMap(component) };
    }
    return {
      sourceId: s.sourceId,
      name: s.name,
      nodes: t.root ? [node(s.sourceId, t.root)] : [],
      notInUse: t.notInUse.map((n) => node(s.sourceId, n)),
      components: [],
    };
  });
  const unplaced = [...inDraft.keys(), ...inPlc.keys()].filter((key) => !placed.has(key));
  return { sources, withoutNode: unplaced.flatMap(component) };
}
