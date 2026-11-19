import { describe, expect, it } from "vitest";
import { ServerMessageSchema, type ServerMessage } from "@rpp/protocol";
import { ConfigEmulation, topologyStructure, type TopologyDeclaration } from "../src/config-emulation";
import type { ST_ConfigTopology } from "../src/config-contract";
import { createGateway } from "../src/gateway";
import { InMemoryPlc } from "../src/in-memory-plc";
import { conveyor, defineMachine, delta, detector } from "../src/plc-builders";

const TOPOLOGY_FB = "MAIN.fbTopology.vo_Config";

/**
 * The topology of a small cell as the RPP application declares it: a line (root) with a cell, the cell with an infeed
 * transport, a pick-and-place handling and a vision unit; a second handling of the full build-out is not in use.
 */
const CELL: TopologyDeclaration = {
  kinds: [
    { name: "Line" },
    { name: "Cell", parents: ["Line"] },
    { name: "Transport", parents: ["Cell"] },
    { name: "PPH", parents: ["Cell"] },
    { name: "DET", parents: ["Cell"] },
  ],
  roles: [
    { name: "Infeed1", holder: "PPH", targets: ["Transport"], required: true },
    { name: "Infeed2", holder: "PPH", targets: ["Transport"] },
    { name: "Transport", holder: "DET", targets: ["Transport"], required: true },
  ],
  nodes: [
    { id: 1, name: "TCAT1", kind: "Line" },
    { id: 10, name: "MPS1", kind: "Cell" },
    { id: 30, name: "TBL1", kind: "Transport", components: [1] },
    { id: 21, name: "PPH1", kind: "PPH", components: [2] },
    { id: 22, name: "PPH2", kind: "PPH" },
    { id: 60, name: "DET1", kind: "DET", components: [3] },
  ],
  root: 1,
  links: [
    { node: 10, role: "parent", target: 1 },
    { node: 30, role: "parent", target: 10 },
    { node: 21, role: "parent", target: 10 },
    { node: 60, role: "parent", target: 10 },
    { node: 21, role: "Infeed1", target: 30 },
    { node: 60, role: "Transport", target: 30 },
  ],
};

/** A PLC with an infeed (1), a Delta (2) and a vision system (3) whose application declares `topology`. */
function setup(options: { topology?: ST_ConfigTopology; configProtocol?: number } = {}) {
  const plc = new InMemoryPlc();
  defineMachine(plc, [
    { id: 1, name: "Infeed", path: "MAIN.stInfeed", kind: "conveyor", value: conveyor() },
    { id: 2, name: "Delta", path: "MAIN.stDelta", kind: "delta", value: delta() },
    { id: 3, name: "Vision", path: "MAIN.stVision", kind: "vision", value: detector() },
  ]);
  const emulation = new ConfigEmulation(plc, [], {
    topology: { path: TOPOLOGY_FB, value: options.topology ?? topologyStructure(CELL) },
    ...(options.configProtocol !== undefined ? { protocolVersion: options.configProtocol } : {}),
  });
  const gateway = createGateway({ plc, sourceId: "plc1", now: () => 0 });
  const messages: ServerMessage[] = [];
  gateway.subscribe((m) => messages.push(ServerMessageSchema.parse(JSON.parse(JSON.stringify(m)))));
  const cycle = async () => {
    emulation.step();
    await gateway.cycle();
  };
  const last = <K extends ServerMessage["kind"]>(kind: K) =>
    messages.filter((m): m is Extract<ServerMessage, { kind: K }> => m.kind === kind).at(-1);
  return { plc, cycle, last };
}

describe("topology (Syn_Config config protocol 5, ADR 0023)", () => {
  it("publishes the declared kinds, roles and nodes with the parents and links in effect", async () => {
    const { cycle, last } = setup();
    await cycle();

    expect(last("parameters")?.topology).toEqual({
      kinds: [
        { name: "Line", parentKinds: [] },
        { name: "Cell", parentKinds: ["Line"] },
        { name: "Transport", parentKinds: ["Cell"] },
        { name: "PPH", parentKinds: ["Cell"] },
        { name: "DET", parentKinds: ["Cell"] },
      ],
      roles: [
        { name: "Infeed1", holderKind: "PPH", targetKinds: ["Transport"], required: true },
        { name: "Infeed2", holderKind: "PPH", targetKinds: ["Transport"], required: false },
        { name: "Transport", holderKind: "DET", targetKinds: ["Transport"], required: true },
      ],
      nodes: [
        { id: 1, name: "TCAT1", kind: "Line", componentIds: [] },
        { id: 10, name: "MPS1", kind: "Cell", componentIds: [] },
        { id: 30, name: "TBL1", kind: "Transport", componentIds: [1] },
        { id: 21, name: "PPH1", kind: "PPH", componentIds: [2] },
        { id: 22, name: "PPH2", kind: "PPH", componentIds: [] },
        { id: 60, name: "DET1", kind: "DET", componentIds: [3] },
      ],
      rootId: 1,
      parents: [
        { node: 10, parent: 1 },
        { node: 30, parent: 10 },
        { node: 21, parent: 10 },
        { node: 60, parent: 10 },
      ],
      links: [
        { node: 21, role: "Infeed1", target: 30 },
        { node: 60, role: "Transport", target: 30 },
      ],
    });
    expect(last("config")?.errors).toEqual([]);
  });

  it("reports what cannot hold in the declaration and leaves it out", async () => {
    const declared = topologyStructure({
      ...CELL,
      nodes: [...CELL.nodes, { id: 23, name: "PPH3", kind: "PPH", components: [2, 9] }],
      root: 99,
    });
    declared.aRoles[1]!.nHolderKind = 12; // Infeed2: a kind not declared
    declared.aNodes[4]!.nKind = 0; // PPH2: no kind
    const { cycle, last } = setup({ topology: declared });
    await cycle();

    const topology = last("parameters")?.topology;
    expect(topology?.roles.map((r) => r.name)).toEqual(["Infeed1", "Transport"]);
    expect(topology?.nodes.map((n) => [n.name, n.componentIds])).toEqual([
      ["TCAT1", []],
      ["MPS1", []],
      ["TBL1", [1]],
      ["PPH1", [2]],
      ["DET1", [3]],
      ["PPH3", [2]],
    ]);
    expect(last("config")?.errors.map((e) => e.message)).toEqual([
      "Topology role Infeed2 is held by kind 12, which is not declared; it is left out.",
      "Topology node PPH2 is of kind 0, which is not declared; it is left out.",
      "Topology node PPH3 stands for component 9, which the Syn_Visu manifest does not list.",
      "The topology's root node 99 is not declared.",
    ]);
  });

  it("publishes no topology when kinds, roles or nodes cannot be told apart", async () => {
    const declared = topologyStructure({ ...CELL, nodes: [...CELL.nodes, { id: 21, name: "PPH9", kind: "PPH" }] });
    const { cycle, last } = setup({ topology: declared });
    await cycle();

    expect(last("parameters")?.topology).toBeUndefined();
    expect(last("config")?.errors).toEqual([
      { path: TOPOLOGY_FB, message: "Cannot read the topology: topology node id 21 is declared twice" },
    ]);
  });

  it("leaves out a link of a node or role not declared", async () => {
    const declared = topologyStructure({
      ...CELL,
      links: [...CELL.links, { node: 77, role: "parent", target: 10 }, { node: 22, role: "Infeed1", target: 78 }],
    });
    declared.stActive.aLinks[declared.stActive.nLinkCount] = { nNode: 22, nRole: 9, nTarget: 30 };
    declared.stActive.nLinkCount += 1;
    const { cycle, last } = setup({ topology: declared });
    await cycle();

    const topology = last("parameters")?.topology;
    expect(topology?.parents).toHaveLength(4);
    expect(topology?.links).toEqual([
      { node: 21, role: "Infeed1", target: 30 },
      { node: 60, role: "Transport", target: 30 },
    ]);
  });
});
