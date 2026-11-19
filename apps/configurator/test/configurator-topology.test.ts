import { describe, expect, it } from "vitest";
import type { Topology } from "@rpp/protocol";
import { A, connected, conveyor, delta, FakeLive } from "./fake-live";

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

function withTopology() {
  const live = new FakeLive();
  live.plc(A, [conveyor(1), delta(2)]);
  live.send({ kind: "parameters", sourceId: A, writable: false, components: [], topology: TOPOLOGY });
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
        available: [
          node(11, "MPS2", "Cell"),
          node(24, "PPH4", "PPH", {
            parent: { id: 11, name: "MPS2" },
            links: [{ role: "Infeed1", target: { id: 30, name: "TBL1" } }],
          }),
          node(25, "PPH5", "PPH", { parent: { id: 26, name: "PPH6" } }),
          node(26, "PPH6", "PPH", { parent: { id: 25, name: "PPH5" } }),
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
});
