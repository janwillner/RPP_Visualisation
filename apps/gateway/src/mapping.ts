import type {
  ComponentConfig,
  ConveyorConfig,
  ConveyorState,
  DeltaConfig,
  DeltaState,
  PlanarPose,
  Pose,
  ProductState,
  WindowKind,
} from "@rpp/protocol";
import {
  E_VisuProductState,
  E_VisuWindowKind,
  enumValue,
  type PlcEnum,
  type ST_VisuConveyorConfig,
  type ST_VisuConveyorState,
  type ST_VisuDeltaConfig,
  type ST_VisuDeltaState,
  type ST_VisuPlanarPose,
  type ST_VisuPose,
} from "./plc-contract";

/** Maps PLC structures (Syn_Visu) to the neutral protocol model. */

export interface ComponentIdentity {
  id: number;
  sourceId: string;
  name: string;
}

function mapPose(p: ST_VisuPose): Pose {
  return { x: p.fX, y: p.fY, z: p.fZ, rx: p.fRx, ry: p.fRy, rz: p.fRz };
}

function mapPlanarPose(p: ST_VisuPlanarPose): PlanarPose {
  return { x: p.fX, y: p.fY, z: p.fZ, rz: p.fRz };
}

function take<T>(items: T[], count: number): T[] {
  return items.slice(0, Math.max(0, Math.min(count, items.length)));
}

export function mapConveyorConfig(identity: ComponentIdentity, c: ST_VisuConveyorConfig): ConveyorConfig {
  return {
    type: "conveyor",
    ...identity,
    pose: mapPose(c.stPose),
    length: c.fLength,
    width: c.fWidth,
    productTypes: take(c.aProductTypes, c.nProductTypeCount).map((t) => ({
      id: t.nId,
      length: t.fLength,
      width: t.fWidth,
      height: t.fHeight,
    })),
  };
}

const WINDOW_KINDS: Record<number, WindowKind> = {
  [E_VisuWindowKind.PICK]: "pick",
  [E_VisuWindowKind.PLACE]: "place",
};

export function mapDeltaConfig(identity: ComponentIdentity, c: ST_VisuDeltaConfig): DeltaConfig {
  return {
    type: "delta",
    ...identity,
    pose: mapPose(c.stPose),
    baseRadius: c.fBaseRadius,
    effectorRadius: c.fEffectorRadius,
    upperArmLength: c.fUpperArmLength,
    lowerArmLength: c.fLowerArmLength,
    hasRotationAxis: c.bHasRotationAxis,
    workArea: {
      radius: c.stWorkArea.fRadius,
      zMin: c.stWorkArea.fZMin,
      zMax: c.stWorkArea.fZMax,
      coneHeight: c.stWorkArea.fConeHeight,
      coneBottomRadius: c.stWorkArea.fConeBottomRadius,
    },
    windows: take(c.aWindows, c.nWindowCount).map((w) => ({
      conveyorId: w.nConveyorId,
      start: w.fStart,
      end: w.fEnd,
      kind: WINDOW_KINDS[enumValue(w.eKind)] ?? "pick",
    })),
  };
}

const PRODUCT_STATES: Record<number, ProductState> = {
  [E_VisuProductState.DETECTED]: "detected",
  [E_VisuProductState.ASSIGNED]: "assigned",
  [E_VisuProductState.PICKED]: "picked",
  [E_VisuProductState.REJECTED]: "rejected",
  [E_VisuProductState.PLACED]: "placed",
};

function mapProductState(e: PlcEnum): ProductState {
  return PRODUCT_STATES[enumValue(e)] ?? "detected";
}

export function mapConveyorState(id: number, s: ST_VisuConveyorState): ConveyorState {
  return {
    type: "conveyor",
    id,
    timestamp: BigInt(s.nTimestamp).toString(),
    encoder: s.fEncoder,
    products: take(s.aProducts, s.nProductCount)
      .filter((p) => p.bValid)
      .map((p) => ({
        id: p.nId,
        latchPose: mapPlanarPose(p.stLatchPose),
        latchEncoder: p.fLatchEncoder,
        state: mapProductState(p.eState),
        robotId: p.nRobotId,
        productType: p.nProductType,
      })),
  };
}

export function mapDeltaState(id: number, s: ST_VisuDeltaState): DeltaState {
  return {
    type: "delta",
    id,
    timestamp: BigInt(s.nTimestamp).toString(),
    actualTcp: mapPlanarPose(s.stActualTcp),
    setpointTcp: mapPlanarPose(s.stSetpointTcp),
  };
}

export type { ComponentConfig };
