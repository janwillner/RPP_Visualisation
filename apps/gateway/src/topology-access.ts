import { z } from "zod";
import type { Topology, TopologyKind, TopologyNode, TopologyRole } from "@rpp/protocol";
import type { ReadPart } from "./read-parts";

/**
 * The machine's topology (library Syn_Config, config protocol 5, ADR 0023): what the application's topology FB
 * declares, read at discovery, and the links in effect, read every cycle, as part of the `parameters` message.
 */

/** The topology FB found in the config manifest (id 0, type NONE, symbol type `ST_ConfigTopology`). */
export interface TopologyFbEntry {
  /** Symbol path of its `vo_Config`. */
  path: string;
  /** What the application declares; its links come from the cyclic read. */
  declaration: Omit<Topology, "parents" | "links">;
  /** The declared role names by role number - 1; links in a role not declared are left out. */
  roleNames: (string | undefined)[];
}

const count = z.number().int().nonnegative();
const LinksSchema = z.object({
  nLinkCount: count,
  aLinks: z.array(z.object({ nNode: z.number().int(), nRole: z.number().int(), nTarget: z.number().int() })),
});
const DeclarationSchema = z.object({
  nKindCount: count,
  aKinds: z.array(z.object({ sName: z.string(), nParentKinds: z.number().int() })),
  nRoleCount: count,
  aRoles: z.array(z.object({ sName: z.string(), nHolderKind: z.number().int(), nTargetKinds: z.number().int(), bRequired: z.boolean() })),
  nNodeCount: count,
  aNodes: z.array(
    z.object({
      nId: z.number().int(),
      sName: z.string(),
      nKind: z.number().int(),
      nComponentCount: count,
      aComponents: z.array(z.number().int()),
    }),
  ),
  nRootNode: z.number().int(),
});

/**
 * Reads what the application declares. A layout the gateway does not know, a kind or role without a name or with the
 * name of another, or a node id declared twice throws a TypeError, which discovery reports. A role or node of a kind
 * not declared is left out, a component the Syn_Visu manifest does not list is left out of its node, and each is
 * named in `errors`, as is a root node not declared.
 */
export function topologyFbEntry(
  path: string,
  raw: unknown,
  componentIds: ReadonlySet<number>,
): { entry: TopologyFbEntry; errors: string[] } {
  const parsed = DeclarationSchema.safeParse(raw);
  if (!parsed.success) throw new TypeError(`unexpected layout of the topology FB: ${parsed.error.issues[0]?.message}`);
  const d = parsed.data;
  const errors: string[] = [];

  const kindNames = d.aKinds.slice(0, d.nKindCount).map((k) => k.sName.trim());
  unique(kindNames, "kind");
  const kindName = (n: number) => kindNames[n - 1];
  /** The names of the kinds set in a DWORD of kind bits; a bit of a kind not declared is named in `errors`. */
  const kindsOf = (bits: number, what: string): string[] => {
    if (bits >>> kindNames.length !== 0) errors.push(`${what} names a kind that is not declared.`);
    return kindNames.filter((_, i) => (bits >>> i) & 1);
  };
  const kinds = d.aKinds.slice(0, d.nKindCount).map((k, i): TopologyKind => ({
    name: kindNames[i]!,
    parentKinds: kindsOf(k.nParentKinds, `Topology kind ${kindNames[i]}`),
  }));

  const roleNames = d.aRoles.slice(0, d.nRoleCount).map((r) => r.sName.trim());
  unique(roleNames, "role");
  const roles: TopologyRole[] = [];
  const usableRoles: (string | undefined)[] = [];
  for (const [i, r] of d.aRoles.slice(0, d.nRoleCount).entries()) {
    const holder = kindName(r.nHolderKind);
    if (holder === undefined) {
      errors.push(`Topology role ${roleNames[i]} is held by kind ${r.nHolderKind}, which is not declared; it is left out.`);
      usableRoles.push(undefined);
      continue;
    }
    roles.push({ name: roleNames[i]!, holderKind: holder, targetKinds: kindsOf(r.nTargetKinds, `Topology role ${roleNames[i]}`), required: r.bRequired });
    usableRoles.push(roleNames[i]);
  }

  const nodes: TopologyNode[] = [];
  const declared = d.aNodes.slice(0, d.nNodeCount);
  unique(declared.map((n) => String(n.nId)), "node id");
  for (const n of declared) {
    const name = n.sName.trim();
    if (name === "") throw new TypeError(`topology node ${n.nId} has no name`);
    const kind = kindName(n.nKind);
    if (kind === undefined) {
      errors.push(`Topology node ${name} is of kind ${n.nKind}, which is not declared; it is left out.`);
      continue;
    }
    const components = n.aComponents.slice(0, n.nComponentCount);
    for (const id of components.filter((c) => !componentIds.has(c))) {
      errors.push(`Topology node ${name} stands for component ${id}, which the Syn_Visu manifest does not list.`);
    }
    nodes.push({ id: n.nId, name, kind, componentIds: components.filter((c) => componentIds.has(c)) });
  }
  if (!nodes.some((n) => n.id === d.nRootNode)) errors.push(`The topology's root node ${d.nRootNode} is not declared.`);

  return { entry: { path, declaration: { kinds, roles, nodes, rootId: d.nRootNode }, roleNames: usableRoles }, errors };
}

/** Throws a TypeError for an empty name or a name used twice. */
function unique(names: readonly string[], what: string): void {
  for (const [i, name] of names.entries()) {
    if (name === "") throw new TypeError(`topology ${what} ${i + 1} has no name`);
    if (names.indexOf(name) < i) throw new TypeError(`topology ${what} ${name} is declared twice`);
  }
}

/**
 * What the cyclic sum-read reads of the topology FB: the links in effect, with the declaration. A link of a node or to
 * a node not declared, or in a role not declared, is left out.
 */
export function topologyFbPart(t: TopologyFbEntry): ReadPart<Topology> {
  const ids = new Set(t.declaration.nodes.map((n) => n.id));
  return {
    paths: [`${t.path}.stActive`],
    map: ([raw]) => {
      const active = LinksSchema.parse(raw);
      const links = active.aLinks.slice(0, active.nLinkCount).filter((l) => ids.has(l.nNode) && ids.has(l.nTarget));
      return {
        ...t.declaration,
        parents: links.filter((l) => l.nRole === 0).map((l) => ({ node: l.nNode, parent: l.nTarget })),
        links: links.flatMap((l) => {
          const role = l.nRole > 0 ? t.roleNames[l.nRole - 1] : undefined;
          return role === undefined ? [] : [{ node: l.nNode, role, target: l.nTarget }];
        }),
      };
    },
    restart: () => {},
  };
}
