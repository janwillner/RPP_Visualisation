import { describe, expect, it } from "vitest";
import type { ComponentConfig, Topology } from "@rpp/protocol";
import { A, connected, conveyor, delta, FakeLive } from "./fake-live";
import { drafted, openDraft } from "./sample-components";

/**
 * A line (root) with two cells. Cell 1 holds an infeed and a pick-and-place handling linked to it; cell 2 hangs from
 * no node, so it and its handling are not in use, and neither are two handlings whose parents form a ring.
 */
const TOPOLOGY: Topology = {
  kinds: [
    { name: "Line", parentKinds: [] },
    { name: "Cell", parentKinds: ["Line"] },
    { name: "Transport", parentKinds: ["Cell"] },
    { name: "PPH", parentKinds: ["Cell", "PPH"] },
  ],
  roles: [{ name: "Infeed1", holderKind: "PPH", targetKinds: ["Transport"], required: true }],
  nodes: [
    { id: 1, name: "TCAT1", kind: "Line", componentIds: [] },
    { id: 10, name: "MPS1", kind: "Cell", componentIds: [] },
    { id: 11, name: "MPS2", kind: "Cell", componentIds: [] },
    { id: 30, name: "TBL1", kind: "Transport", componentIds: [1] },
    { id: 21, name: "PPH1", kind: "PPH", componentIds: [2] },
    { id: 24, name: "PPH4", kind: "PPH", componentIds: [] },
    { id: 25, name: "PPH5", kind: "PPH", componentIds: [] },
    { id: 26, name: "PPH6", kind: "PPH", componentIds: [] },
  ],
  rootId: 1,
  parents: [
    { node: 10, parent: 1 },
    { node: 30, parent: 10 },
    { node: 21, parent: 10 },
    { node: 24, parent: 11 },
    { node: 25, parent: 26 },
    { node: 26, parent: 25 },
  ],
  links: [
    { node: 21, role: "Infeed1", target: 30 },
    { node: 24, role: "Infeed1", target: 30 },
  ],
};

function withTopology(topology: Topology = TOPOLOGY, components: ComponentConfig[] = [conveyor(1), delta(2)]) {
  const live = new FakeLive();
  live.plc(A, components);
  live.send({ kind: "parameters", sourceId: A, writable: false, components: [], topology });
  const c = connected(live);
  c.importSource(A);
  return c;
}

describe("Configurator: a PLC's topology (ADR 0023)", () => {
  it("shows the topology as a tree along the parents from the root node, the nodes not in use below it", () => {
    const c = withTopology();

    const node = (id: number, name: string, kind: string, more: object = {}) => ({
      id,
      name,
      kind,
      inUse: true,
      parent: undefined,
      components: [],
      links: [],
      children: [],
      ...more,
    });
    const mps1 = { id: 10, name: "MPS1" };
    expect(c.getSnapshot().topologies).toEqual([
      {
        sourceId: A,
        root: node(1, "TCAT1", "Line", {
          children: [
            node(10, "MPS1", "Cell", {
              parent: { id: 1, name: "TCAT1" },
              children: [
                node(30, "TBL1", "Transport", { parent: mps1, components: [`${A}#1`] }),
                node(21, "PPH1", "PPH", {
                  parent: mps1,
                  components: [`${A}#2`],
                  links: [{ role: "Infeed1", target: { id: 30, name: "TBL1" } }],
                }),
              ],
            }),
          ],
        }),
        notInUse: [
          node(11, "MPS2", "Cell", { inUse: false }),
          node(24, "PPH4", "PPH", {
            inUse: false,
            parent: { id: 11, name: "MPS2" },
            links: [{ role: "Infeed1", target: { id: 30, name: "TBL1" } }],
          }),
          node(25, "PPH5", "PPH", { inUse: false, parent: { id: 26, name: "PPH6" } }),
          node(26, "PPH6", "PPH", { inUse: false, parent: { id: 25, name: "PPH5" } }),
        ],
      },
    ]);
  });

  it("shows no topology for a PLC whose application declares none", () => {
    const live = new FakeLive();
    live.plc(A, [conveyor(1)]);
    live.send({ kind: "parameters", sourceId: A, writable: false, components: [] });

    expect(connected(live).getSnapshot().topologies).toEqual([]);
  });

  it("selects a node with the first of its components in the draft, and the node of a selected component", () => {
    const c = withTopology();

    c.selectNode(A, 21);
    expect(c.getSnapshot()).toMatchObject({ selectedNode: { sourceId: A, id: 21 }, selection: `${A}#2` });

    c.selectNode(A, 10);
    expect(c.getSnapshot()).toMatchObject({ selectedNode: { sourceId: A, id: 10 }, selection: undefined });

    c.select(`${A}#1`);
    expect(c.getSnapshot()).toMatchObject({ selectedNode: { sourceId: A, id: 30 }, selection: `${A}#1` });

    c.select(undefined);
    expect(c.getSnapshot().selectedNode).toBeUndefined();
  });

  describe("component tree", () => {
    it("hangs each component under the node that stands for it, along the topology from the root node", () => {
      const c = withTopology();

      const [line] = c.getSnapshot().draftTree.sources;
      expect(line).toMatchObject({ sourceId: A, name: "Line PLC", components: [] });
      expect(line!.nodes).toEqual([
        {
          node: { sourceId: A, id: 1 },
          name: "TCAT1",
          kind: "Line",
          components: [],
          children: [
            {
              node: { sourceId: A, id: 10 },
              name: "MPS1",
              kind: "Cell",
              components: [],
              children: [
                {
                  node: { sourceId: A, id: 30 },
                  name: "TBL1",
                  kind: "Transport",
                  components: [{ key: `${A}#1`, id: 1, name: "Belt 1", inDraft: true }],
                  children: [],
                },
                {
                  node: { sourceId: A, id: 21 },
                  name: "PPH1",
                  kind: "PPH",
                  components: [{ key: `${A}#2`, id: 2, name: "Delta 2", inDraft: true }],
                  children: [],
                },
              ],
            },
          ],
        },
      ]);
      expect(c.getSnapshot().draftTree.withoutNode).toEqual([]);
    });

    it("lists the components no node stands for apart: the draft's own, then those only in the PLC", () => {
      const live = new FakeLive();
      live.plc(A, [conveyor(1), delta(2), conveyor(4)]);
      live.send({ kind: "parameters", sourceId: A, writable: false, components: [], topology: TOPOLOGY });
      // A draft saved earlier holds a conveyor of a source no PLC has; Belt 4 of the PLC belongs to no node.
      const c = openDraft(connected(live), drafted("conveyor", 1));
      c.importSource(A);
      c.remove(`${A}#4`);

      expect(c.getSnapshot().draftTree.withoutNode).toEqual([
        { key: "draft#1", id: 1, name: "Conveyor 1", inDraft: true },
        { key: `${A}#4`, id: 4, name: "Belt 4", inDraft: false },
      ]);
    });

    it("lists the components of a PLC without a topology flat, those only in the PLC after the draft's", () => {
      const live = new FakeLive();
      live.plc(A, [conveyor(1), delta(2), conveyor(3)]);
      live.send({ kind: "parameters", sourceId: A, writable: false, components: [] });
      const c = connected(live);
      c.importSource(A);
      c.remove(`${A}#1`);

      expect(c.getSnapshot().draftTree).toEqual({
        sources: [
          {
            sourceId: A,
            name: "Line PLC",
            nodes: [],
            notInUse: [],
            components: [
              { key: `${A}#2`, id: 2, name: "Delta 2", inDraft: true },
              { key: `${A}#3`, id: 3, name: "Belt 3", inDraft: true },
              { key: `${A}#1`, id: 1, name: "Belt 1", inDraft: false },
            ],
          },
        ],
        withoutNode: [],
      });
    });

    it("lists the nodes not in use with their components apart from the tree", () => {
      // PPH4 hangs from MPS2, which hangs from no node: its Delta is part of the build-out, not of this machine.
      const topology = { ...TOPOLOGY, nodes: TOPOLOGY.nodes.map((n) => (n.id === 24 ? { ...n, componentIds: [3] } : n)) };
      const c = withTopology(topology, [conveyor(1), delta(2), delta(3)]);

      const leaf = (id: number, name: string, kind: string, components: object[] = []) => ({
        node: { sourceId: A, id },
        name,
        kind,
        components,
        children: [],
      });
      expect(c.getSnapshot().draftTree.sources[0]!.notInUse).toEqual([
        leaf(11, "MPS2", "Cell"),
        leaf(24, "PPH4", "PPH", [{ key: `${A}#3`, id: 3, name: "Delta 3", inDraft: true }]),
        leaf(25, "PPH5", "PPH"),
        leaf(26, "PPH6", "PPH"),
      ]);
    });

    it("lists a component only its PLC has under its node, to be taken into the draft", () => {
      const c = withTopology();
      c.remove(`${A}#2`);

      const pph1 = c.getSnapshot().draftTree.sources[0]!.nodes[0]!.children[0]!.children[1]!;
      expect(pph1).toMatchObject({ name: "PPH1", components: [{ key: `${A}#2`, id: 2, name: "Delta 2", inDraft: false }] });
    });
  });
});
