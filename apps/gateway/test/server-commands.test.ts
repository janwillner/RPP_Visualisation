import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ServerMessageSchema, type ParametersMessage, type ServerMessage } from "@rpp/protocol";
import { combineGateways, createGateway } from "../src/gateway";
import { NOT_ALLOWED } from "../src/parameter-access";
import { FOREIGN_ORIGIN, startServer } from "../src/server";
import { fixtureMachine, FIXTURE_SOURCE } from "./fixture-machine";

/** The fixture machine behind a server; a WebSocket client that collects every message. */
async function connect(allowWrite: boolean) {
  const machine = fixtureMachine();
  const gateway = createGateway({ plc: machine.plc, sourceId: FIXTURE_SOURCE, allowWrite });
  machine.step();
  await gateway.cycle();
  const server = await startServer({ gateway: combineGateways([gateway]), port: 0, host: "127.0.0.1" });
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`);
  const messages: ServerMessage[] = [];
  socket.on("message", (data) => messages.push(ServerMessageSchema.parse(JSON.parse(String(data)))));
  await new Promise((resolve) => socket.once("open", resolve));
  const next = async <K extends ServerMessage["kind"]>(kind: K) => {
    for (let i = 0; i < 100; i++) {
      const found = messages.find((m) => m.kind === kind);
      if (found) return found as Extract<ServerMessage, { kind: K }>;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${kind}`);
  };
  const close = () => {
    socket.close();
    server.close();
  };
  return { socket, messages, next, close, machine, gateway };
}

describe("WebSocket commands (ADR 0017)", () => {
  it("hands a new client the parameter sets and answers a write command to that client only", async () => {
    const { socket, next, close } = await connect(true);
    try {
      const parameters: ParametersMessage = await next("parameters");
      expect(parameters).toMatchObject({ sourceId: FIXTURE_SOURCE, writable: true });
      const robot = parameters.components.find((c) => c.set.type === "delta")!;

      socket.send("not json");
      socket.send(JSON.stringify({ kind: "somethingElse" }));
      socket.send(
        JSON.stringify({ kind: "writeParameters", requestId: 7, sourceId: FIXTURE_SOURCE, componentId: robot.id, baseVersion: 0, set: robot.set }),
      );
      expect(await next("writeResult")).toEqual({ kind: "writeResult", requestId: 7, ok: true, stageId: expect.any(Number) });
    } finally {
      close();
    }
  });

  it("refuses commands from a page of another origin: a foreign web page must not write to the PLC", async () => {
    const machine = fixtureMachine();
    const gateway = createGateway({ plc: machine.plc, sourceId: FIXTURE_SOURCE, allowWrite: true });
    machine.step();
    await gateway.cycle();
    const server = await startServer({ gateway: combineGateways([gateway]), port: 0, host: "127.0.0.1" });
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "http://evil.example" });
    const messages: ServerMessage[] = [];
    socket.on("message", (data) => messages.push(ServerMessageSchema.parse(JSON.parse(String(data)))));
    try {
      await new Promise((resolve) => socket.once("open", resolve));
      for (let i = 0; i < 100 && !messages.some((m) => m.kind === "parameters"); i++) await new Promise((r) => setTimeout(r, 10));
      const robot = (messages.find((m) => m.kind === "parameters") as ParametersMessage).components.find((c) => c.set.type === "delta")!;
      socket.send(JSON.stringify({ kind: "writeParameters", requestId: 9, sourceId: FIXTURE_SOURCE, componentId: robot.id, baseVersion: 0, set: robot.set }));
      // Recipes and machine commands alike (ADR 0022).
      socket.send(JSON.stringify({ kind: "writeRecipe", requestId: 10, sourceId: FIXTURE_SOURCE, baseVersion: 0, values: {} }));
      socket.send(JSON.stringify({ kind: "resetRecipe", requestId: 11, sourceId: FIXTURE_SOURCE, baseVersion: 0 }));
      socket.send(JSON.stringify({ kind: "machineCommand", requestId: 12, sourceId: FIXTURE_SOURCE, command: "start" }));
      for (let i = 0; i < 100 && messages.filter((m) => m.kind === "writeResult").length < 4; i++) await new Promise((r) => setTimeout(r, 10));
      expect(messages.filter((m) => m.kind === "writeResult")).toEqual(
        [9, 10, 11, 12].map((requestId) => ({ kind: "writeResult", requestId, ok: false, error: FOREIGN_ORIGIN })),
      );
    } finally {
      socket.close();
      server.close();
    }
  });

  it("answers with the reason when the gateway does not allow writing", async () => {
    const { socket, next, close } = await connect(false);
    try {
      const robot = (await next("parameters")).components.find((c) => c.set.type === "delta")!;
      socket.send(
        JSON.stringify({ kind: "writeParameters", requestId: 8, sourceId: FIXTURE_SOURCE, componentId: robot.id, baseVersion: 0, set: robot.set }),
      );
      expect(await next("writeResult")).toEqual({ kind: "writeResult", requestId: 8, ok: false, error: NOT_ALLOWED });
    } finally {
      close();
    }
  });
});
