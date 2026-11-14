import { describe, expect, it } from "vitest";
import { writeBlockedReason, type WriteFacts, type WriteKind } from "../src/parameters";

/** A source every write can go to: online, Syn_Config with a machine FB, writable, in simulation mode. */
const OPEN: WriteFacts = { online: true, parameters: { writable: true, recipe: {} }, simulation: true };

describe("why a write to a source is blocked: the one rule of the gateway, the configurator and the Simulator", () => {
  it.each<[string, WriteKind, Partial<WriteFacts>, RegExp | undefined]>([
    ["a parameter set to an open source", "parameters", {}, undefined],
    ["a recipe to an open source", "recipe", {}, undefined],
    ["a machine command to an open source", "machineCommand", {}, undefined],
    ["anything to an offline PLC", "parameters", { online: false }, /PLC is not connected/],
    ["a parameter set to a PLC without Syn_Config", "parameters", { parameters: undefined }, /no Syn_Config/],
    ["a recipe to a PLC without Syn_Config", "recipe", { parameters: undefined }, /no machine FB/],
    ["a parameter set the gateway may not write", "parameters", { parameters: { writable: false, reason: "No --allow-write." } }, /^No --allow-write\.$/],
    ["a recipe the gateway may not write", "recipe", { parameters: { writable: false, reason: "No --allow-write.", recipe: {} } }, /^No --allow-write\.$/],
    ["a parameter set without a reason given", "parameters", { parameters: { writable: false } }, /cannot be written/],
    ["a recipe to an application without a machine FB", "recipe", { parameters: { writable: true } }, /no machine FB/],
    ["a machine command to an application without a machine FB", "machineCommand", { parameters: { writable: true } }, /no machine FB/],
    ["a recipe to a machine not in simulation mode", "recipe", { simulation: false }, /not in simulation mode/],
    ["a machine command to a machine not in simulation mode", "machineCommand", { simulation: false }, /not in simulation mode/],
    ["a parameter set to a machine not in simulation mode", "parameters", { simulation: false }, undefined],
  ])("%s", (_, kind, facts, reason) => {
    const blocked = writeBlockedReason(kind, { ...OPEN, ...facts });
    if (reason) expect(blocked).toMatch(reason);
    else expect(blocked).toBeUndefined();
  });
});
