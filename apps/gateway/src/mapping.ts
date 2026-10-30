import type {
  CartesianConfig,
  CartesianState,
  ComponentConfig,
  ConveyorConfig,
  ConveyorState,
  DeltaConfig,
  DeltaState,
  Finger,
  FingerState,
  PlanarPose,
  Position,
  Pose,
  ProductState,
  XtsGantryConfig,
  XtsGantryState,
  XtsLoopConfig,
  XtsLoopState,
  Zone,
  ZoneKind,
} from "@rpp/protocol";
import {
  E_VisuProductState,
  E_VisuZoneKind,
  enumValue,
  type PlcEnum,
  type ST_VisuCartesianConfig,
  type ST_VisuCartesianState,
  type ST_VisuConveyorConfig,
  type ST_VisuConveyorState,
  type ST_VisuDeltaConfig,
  type ST_VisuDeltaState,
  type ST_VisuFinger,
  type ST_VisuFingerState,
  type ST_VisuPlanarPose,
  type ST_VisuPosition,
  type ST_VisuPose,
  type ST_VisuXtsGantryConfig,
  type ST_VisuXtsGantryState,
  type ST_VisuXtsLoopConfig,
  type ST_VisuXtsLoopState,
  type ST_VisuZone,
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

function mapPosition(p: ST_VisuPosition): Position {
  return { x: p.fX, y: p.fY, z: p.fZ };
}

function take<T>(items: T[], count: number): T[] {
  return items.slice(0, Math.max(0, Math.min(count, items.length)));
}

function mapFingers(c: { nFingerCount: number; aFingers: ST_VisuFinger[] }): Finger[] {
  return take(c.aFingers, c.nFingerCount).map((f) => ({ diameter: f.fDiameter, height: f.fHeight }));
}

/** Finger states for the configured fingers only. */
function mapFingerStates(states: ST_VisuFingerState[], count: number): FingerState[] {
  return take(states, count).map((f) => ({ pose: mapPose(f.stPose), active: f.bActive }));
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

const ZONE_KINDS: Record<number, ZoneKind> = {
  [E_VisuZoneKind.PICK]: "pick",
  [E_VisuZoneKind.PLACE]: "place",
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
    workingArea: {
      radius: c.stWorkingArea.fRadius,
      zMin: c.stWorkingArea.fZMin,
      zMax: c.stWorkingArea.fZMax,
      coneHeight: c.stWorkingArea.fConeHeight,
      coneBottomRadius: c.stWorkingArea.fConeBottomRadius,
    },
    limitArea: c.stLimitArea.bActive
      ? {
          xMin: c.stLimitArea.fXMin,
          xMax: c.stLimitArea.fXMax,
          yMin: c.stLimitArea.fYMin,
          yMax: c.stLimitArea.fYMax,
          zMin: c.stLimitArea.fZMin,
          zMax: c.stLimitArea.fZMax,
        }
      : null,
    zones: mapZones(c.aZones, c.nZoneCount),
    fingers: mapFingers(c),
  };
}

function mapZones(zones: ST_VisuZone[], count: number): Zone[] {
  return take(zones, count).map((w) => ({
    conveyorId: w.nConveyorId,
    start: w.fStart,
    end: w.fEnd,
    kind: ZONE_KINDS[enumValue(w.eKind)] ?? "pick",
    allocationOffset: w.fAllocationOffset,
  }));
}

export function mapXtsGantryConfig(identity: ComponentIdentity, c: ST_VisuXtsGantryConfig): XtsGantryConfig {
  return {
    type: "xtsGantry",
    ...identity,
    pose: mapPose(c.stPose),
    moduleCount: c.nModuleCount,
    moduleLength: c.fModuleLength,
    xMin: c.fXMin,
    xMax: c.fXMax,
    zMin: c.fZMin,
    zMax: c.fZMax,
    toolOffsetX: c.fToolOffsetX,
    toolOffsetZ: c.fToolOffsetZ,
    moverLength: c.fMoverLength,
    moverWidth: c.fMoverWidth,
    zones: mapZones(c.aZones, c.nZoneCount),
    fingers: mapFingers(c),
  };
}

export function mapXtsLoopConfig(identity: ComponentIdentity, c: ST_VisuXtsLoopConfig): XtsLoopConfig {
  return {
    type: "xtsLoop",
    ...identity,
    pose: mapPose(c.stPose),
    straightLength: c.fStraightLength,
    curveRadius: c.fCurveRadius,
    toolOffset: c.fToolOffset,
    moverLength: c.fMoverLength,
    moverWidth: c.fMoverWidth,
    zones: mapZones(c.aZones, c.nZoneCount),
    fingers: mapFingers(c),
  };
}

export function mapXtsGantryState(id: number, s: ST_VisuXtsGantryState, fingerCount: number): XtsGantryState {
  return {
    type: "xtsGantry",
    id,
    timestamp: BigInt(s.nTimestamp).toString(),
    z: s.fZ,
    movers: take(s.aMovers, s.nMoverCount)
      .filter((m) => m.bValid)
      .map((m) => ({
        id: m.nId,
        position: m.fPosition,
        x: m.fX,
        gripperActive: m.bGripperActive,
        fingers: mapFingerStates(m.aFingerStates, fingerCount),
      })),
  };
}

export function mapXtsLoopState(id: number, s: ST_VisuXtsLoopState, fingerCount: number): XtsLoopState {
  return {
    type: "xtsLoop",
    id,
    timestamp: BigInt(s.nTimestamp).toString(),
    movers: take(s.aMovers, s.nMoverCount)
      .filter((m) => m.bValid)
      .map((m) => ({ id: m.nId, position: m.fPosition, fingers: mapFingerStates(m.aFingerStates, fingerCount) })),
  };
}

export function mapCartesianConfig(identity: ComponentIdentity, c: ST_VisuCartesianConfig): CartesianConfig {
  return {
    type: "cartesian",
    ...identity,
    pose: mapPose(c.stPose),
    xMin: c.fXMin,
    xMax: c.fXMax,
    yMin: c.fYMin,
    yMax: c.fYMax,
    zMin: c.fZMin,
    zMax: c.fZMax,
    railHeight: c.fRailHeight,
    zones: mapZones(c.aZones, c.nZoneCount),
    fingers: mapFingers(c),
  };
}

export function mapCartesianState(id: number, s: ST_VisuCartesianState, fingerCount: number): CartesianState {
  return {
    type: "cartesian",
    id,
    timestamp: BigInt(s.nTimestamp).toString(),
    x: s.fX,
    y: s.fY,
    z: s.fZ,
    gripperActive: s.bGripperActive,
    fingers: mapFingerStates(s.aFingerStates, fingerCount),
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
    beltPosition: s.fBeltPosition,
    products: take(s.aProducts, s.nProductCount)
      .filter((p) => p.bValid)
      .map((p) => ({
        id: p.nId,
        latchPose: mapPlanarPose(p.stLatchPose),
        latchBeltPosition: p.fLatchBeltPosition,
        state: mapProductState(p.eState),
        robotId: p.nRobotId,
        moverId: p.nMoverId,
        fingerId: p.nFingerId,
        productType: p.nProductType,
      })),
  };
}

export function mapDeltaState(id: number, s: ST_VisuDeltaState, fingerCount: number): DeltaState {
  return {
    type: "delta",
    id,
    timestamp: BigInt(s.nTimestamp).toString(),
    actualTcp: mapPosition(s.stActualTcp),
    setpointTcp: mapPosition(s.stSetpointTcp),
    fingers: mapFingerStates(s.aFingerStates, fingerCount),
  };
}

export type { ComponentConfig };
