import { z } from "zod";

/**
 * A machine's topology (ADR 0023): how the parts of its application relate, as the application declares them in
 * Syn_Config's topology FB. The application names the kinds of its topology nodes, the roles a link may have and its
 * nodes with the components they stand for; every node but the root node has a parent, and a node may point to other
 * nodes in its kind's roles.
 */

const int = (description: string) => z.number().int().describe(description);

export const TopologyKindSchema = z
  .object({
    name: z.string().describe("The kind's name, unique in the topology, e.g. `PPH`, `Transport`."),
    parentKinds: z.array(z.string()).describe("The kinds a node of this kind may have as its parent."),
  })
  .describe("A kind of topology node, as the application declares it.");
export type TopologyKind = z.infer<typeof TopologyKindSchema>;

export const TopologyRoleSchema = z
  .object({
    name: z.string().describe("The role's name, unique in the topology, e.g. `Infeed1`."),
    holderKind: z.string().describe("The kind of node that holds the role."),
    targetKinds: z.array(z.string()).describe("The kinds of node a link in this role may point to."),
    required: z.boolean().describe("A node in use of the holder kind must have a link in this role."),
  })
  .describe("What a link means, as the application declares it.");
export type TopologyRole = z.infer<typeof TopologyRoleSchema>;

export const TopologyNodeSchema = z
  .object({
    id: int("The application's id of the node, unique in the topology."),
    name: z.string().describe("The node's name, e.g. `PPH1`."),
    kind: z.string().describe("The node's kind."),
    componentIds: z
      .array(z.number().int())
      .describe("Manifest ids of the components the node stands for; empty for a node without one (a cell)."),
  })
  .describe("One part of the application's machine with a place in its topology.");
export type TopologyNode = z.infer<typeof TopologyNodeSchema>;

export const TopologyParentSchema = z
  .object({
    node: int("Id of the node."),
    parent: int("Id of its parent."),
  })
  .describe("A node's parent.");
export type TopologyParent = z.infer<typeof TopologyParentSchema>;

export const TopologyLinkSchema = z
  .object({
    node: int("Id of the node that holds the link."),
    role: z.string().describe("Name of the link's role."),
    target: int("Id of the node the link points to."),
  })
  .describe("One link of the topology: a node points to another node in a role.");
export type TopologyLink = z.infer<typeof TopologyLinkSchema>;

export const TopologySchema = z
  .object({
    kinds: z.array(TopologyKindSchema).describe("Every kind of node the application declares."),
    roles: z.array(TopologyRoleSchema).describe("Every role the application declares."),
    nodes: z.array(TopologyNodeSchema).describe("Every node of the full build-out, in use or not."),
    rootId: int("Id of the root node, which has no parent."),
    parents: z
      .array(TopologyParentSchema)
      .describe("The parents in effect: those the application linked at its last start (its program values)."),
    links: z.array(TopologyLinkSchema).describe("The links in effect in every role, as `parents`."),
  })
  .describe("The machine's topology as its application declares it and runs with it (Syn_Config config protocol 5).");
export type Topology = z.infer<typeof TopologySchema>;

/**
 * The ids of the nodes in use: the root node, and every node whose chain of parents reaches it. A node whose parent
 * is not in use is not in use either, nor is one in a ring of parents.
 */
export function nodesInUse(topology: Pick<Topology, "nodes" | "rootId" | "parents">): Set<number> {
  // A node's first parent link counts, as everywhere a topology is read.
  const parentOf = new Map<number, number>();
  for (const p of topology.parents) if (!parentOf.has(p.node)) parentOf.set(p.node, p.parent);
  const inUse = new Set<number>();
  if (!topology.nodes.some((n) => n.id === topology.rootId)) return inUse;
  inUse.add(topology.rootId);
  for (const node of topology.nodes) {
    const chain: number[] = [];
    let at: number | undefined = node.id;
    while (at !== undefined && !inUse.has(at) && !chain.includes(at)) {
      chain.push(at);
      at = parentOf.get(at);
    }
    if (at !== undefined && inUse.has(at)) for (const id of chain) inUse.add(id);
  }
  return inUse;
}
