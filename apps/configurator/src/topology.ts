import { nodesInUse, type ParametersMessage, type Topology } from "@rpp/protocol";
import { componentKey, type ComponentKey } from "@rpp/machine-view";

/**
 * A PLC's topology as the configurator shows it (ADR 0023): the nodes in use as a tree along their parents from the
 * root node, and the nodes of the full build-out not in use beside it.
 */

/** A node named by another: its parent or a link's target. */
export interface NodeRef {
  id: number;
  name: string;
}

export interface TopologyNodeView {
  id: number;
  name: string;
  kind: string;
  parent: NodeRef | undefined;
  /** The components the node stands for, as keys of its source. */
  components: ComponentKey[];
  /** Its links in every role, in the declared order of the links. */
  links: { role: string; target: NodeRef }[];
  /** The nodes in use whose parent it is; always empty for a node not in use. */
  children: TopologyNodeView[];
}

export interface SourceTopology {
  sourceId: string;
  /** The root node with every node in use below it; undefined when the root node is not declared. */
  root: TopologyNodeView | undefined;
  /** The nodes not in use, in their declared order. */
  available: TopologyNodeView[];
}

/** A node of a source's topology. */
export interface NodeKey {
  sourceId: string;
  id: number;
}

/** The topology of every source that has one, in the order of the sources. */
export function sourceTopologies(parameters: Readonly<Record<string, ParametersMessage>>): SourceTopology[] {
  return Object.values(parameters).flatMap((p) => (p.topology ? [sourceTopology(p.sourceId, p.topology)] : []));
}

function sourceTopology(sourceId: string, t: Topology): SourceTopology {
  const inUse = nodesInUse(t);
  const ref = (id: number): NodeRef | undefined => {
    const node = t.nodes.find((n) => n.id === id);
    return node && { id: node.id, name: node.name };
  };
  const view = (node: Topology["nodes"][number]): TopologyNodeView => {
    const parent = t.parents.find((p) => p.node === node.id);
    return {
      id: node.id,
      name: node.name,
      kind: node.kind,
      parent: parent && ref(parent.parent),
      components: node.componentIds.map((id) => componentKey(sourceId, id)),
      links: t.links.flatMap((l) => {
        const target = l.node === node.id ? ref(l.target) : undefined;
        return target ? [{ role: l.role, target }] : [];
      }),
      children:
        inUse.has(node.id)
          ? t.nodes.filter((n) => n.id !== t.rootId && inUse.has(n.id) && t.parents.some((p) => p.node === n.id && p.parent === node.id)).map(view)
          : [],
    };
  };
  const root = t.nodes.find((n) => n.id === t.rootId);
  return { sourceId, root: root && view(root), available: t.nodes.filter((n) => !inUse.has(n.id)).map(view) };
}

/** The node of `sourceId`'s topology that stands for component `key`; undefined when none does. */
export function nodeOf(topologies: readonly SourceTopology[], key: ComponentKey): NodeKey | undefined {
  for (const t of topologies) {
    const found = find(t, (n) => n.components.includes(key));
    if (found) return { sourceId: t.sourceId, id: found.id };
  }
  return undefined;
}

/** The node `key` names, in use or not. */
export function topologyNode(topologies: readonly SourceTopology[], key: NodeKey): TopologyNodeView | undefined {
  const t = topologies.find((s) => s.sourceId === key.sourceId);
  return t && find(t, (n) => n.id === key.id);
}

function find(t: SourceTopology, test: (n: TopologyNodeView) => boolean): TopologyNodeView | undefined {
  const walk = (n: TopologyNodeView): TopologyNodeView | undefined => (test(n) ? n : n.children.map(walk).find(Boolean));
  return (t.root && walk(t.root)) ?? t.available.find(test);
}
