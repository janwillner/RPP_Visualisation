import { z } from "zod";
import { ParameterResultSchema } from "@rpp/protocol";
import { mapPlc } from "./plc-mapping";
import type { SymbolWrite } from "./symbol-access";

/**
 * The staging every Syn_Config write goes through (ADR 0017; the machine FB's recipe reuses it, ADR 0022): a parameter
 * FB's or the machine FB's `stStaging` and `stStatus`. The order of a write is what makes it safe: a set still waiting
 * to be allowed is withdrawn first, so it is never taken over half overwritten, and `bStaged` (or `bReset`) comes
 * last, in the same sum-write.
 */

/** A staging's status as the gateway reads it from `stStatus`. */
const StagingStatusSchema = z.object({
  activeVersion: z.number().int(),
  handledStageId: z.number().int(),
  result: ParameterResultSchema,
  message: z.string(),
});
export type StagingStatus = z.infer<typeof StagingStatusSchema>;

/** The status read from a staging FB's `stStatus`. */
export function stagingStatus(raw: unknown): StagingStatus {
  return mapPlc(StagingStatusSchema, raw);
}

/**
 * Why a write based on `base` cannot go to an FB with `active` version active; undefined when it can. `what` names it,
 * e.g. "Component 2 has parameter version".
 */
export function staleBase(what: string, active: number, base: number): string | undefined {
  return active === base ? undefined : `${what} ${active} active, not ${base}: reconcile again before writing.`;
}

/** The writes that stage `payload` (the staged values) on the FB at `fbPath`, based on version `base`, as `stageId`. */
export function stageWrites(fbPath: string, base: number, stageId: number, payload: readonly SymbolWrite[]): SymbolWrite[] {
  const staging = `${fbPath}.stStaging`;
  return [
    { path: `${staging}.bStaged`, value: false },
    ...payload,
    { path: `${staging}.nBaseVersion`, value: base },
    { path: `${staging}.nStageId`, value: stageId },
    { path: `${staging}.bReset`, value: false },
    { path: `${staging}.bStaged`, value: true },
  ];
}

/** The writes that make the FB's active set invalid (its application's program values apply again), as `stageId`. */
export function resetWrites(fbPath: string, base: number, stageId: number): SymbolWrite[] {
  const staging = `${fbPath}.stStaging`;
  return [
    { path: `${staging}.nBaseVersion`, value: base },
    { path: `${staging}.nStageId`, value: stageId },
    { path: `${staging}.bReset`, value: true },
  ];
}
