import { PROTOCOL_VERSION } from "@rpp/protocol";
import {
  E_VisuComponentType,
  E_VisuProductState,
  E_VisuWindowKind,
  MANIFEST_PATH,
  PLC_TYPES,
  type ST_VisuConveyor,
  type ST_VisuDelta,
  type ST_VisuManifest,
  type ST_VisuManifestEntry,
  type ST_VisuPose,
  type ST_VisuProduct,
  type ST_VisuWindow,
} from "./plc-contract";
import type { InMemoryPlc } from "./in-memory-plc";

/** Library defaults (constants in Tc3_Visu, overridable per project). */
export const MAX_MANIFEST_ENTRIES = 32;
export const MAX_PRODUCTS = 128;
export const MAX_PRODUCT_TYPES = 8;
export const MAX_WINDOWS = 8;

export function pose(p: Partial<ST_VisuPose> = {}): ST_VisuPose {
  return { fX: 0, fY: 0, fZ: 0, fRx: 0, fRy: 0, fRz: 0, ...p };
}

export function emptyProduct(): ST_VisuProduct {
  return {
    nId: 0,
    bValid: false,
    stLatchPose: { fX: 0, fY: 0, fZ: 0, fRz: 0 },
    fLatchEncoder: 0,
    eState: E_VisuProductState.DETECTED,
    nRobotId: 0,
    nProductType: 0,
  };
}

function padded<T>(items: T[], size: number, empty: () => T): T[] {
  return [...items, ...Array.from({ length: Math.max(0, size - items.length) }, empty)];
}

export interface ConveyorSpec {
  pose?: Partial<ST_VisuPose>;
  length?: number;
  width?: number;
  productTypes?: { nId: number; fLength: number; fWidth: number; fHeight: number }[];
  encoder?: number;
  timestamp?: bigint;
  products?: Partial<ST_VisuProduct>[];
}

export function conveyor(spec: ConveyorSpec = {}): ST_VisuConveyor {
  const productTypes = spec.productTypes ?? [{ nId: 1, fLength: 100, fWidth: 80, fHeight: 50 }];
  const products = (spec.products ?? []).map((p) => ({ ...emptyProduct(), bValid: true, ...p }));
  return {
    stConfig: {
      stPose: pose(spec.pose),
      fLength: spec.length ?? 2000,
      fWidth: spec.width ?? 400,
      nProductTypeCount: productTypes.length,
      aProductTypes: padded(productTypes, MAX_PRODUCT_TYPES, () => ({ nId: 0, fLength: 0, fWidth: 0, fHeight: 0 })),
    },
    stState: {
      nTimestamp: spec.timestamp ?? 0n,
      fEncoder: spec.encoder ?? 0,
      nProductCount: products.length,
      aProducts: padded(products, MAX_PRODUCTS, emptyProduct),
    },
  };
}

export interface DeltaSpec {
  pose?: Partial<ST_VisuPose>;
  baseRadius?: number;
  effectorRadius?: number;
  upperArmLength?: number;
  lowerArmLength?: number;
  hasRotationAxis?: boolean;
  axes?: { fAngleOffset: number; nDirection: number }[];
  windows?: ST_VisuWindow[];
  timestamp?: bigint;
  axisPositions?: number[];
}

export function delta(spec: DeltaSpec = {}): ST_VisuDelta {
  const windows = spec.windows ?? [];
  const axes = spec.axes ?? [];
  return {
    stConfig: {
      stPose: pose(spec.pose),
      fBaseRadius: spec.baseRadius ?? 200,
      fEffectorRadius: spec.effectorRadius ?? 50,
      fUpperArmLength: spec.upperArmLength ?? 350,
      fLowerArmLength: spec.lowerArmLength ?? 800,
      bHasRotationAxis: spec.hasRotationAxis ?? false,
      aAxes: padded(axes, 4, () => ({ fAngleOffset: 0, nDirection: 1 })),
      stWorkArea: { fRadius: 600, fZMin: -1100, fZMax: -600, fConeHeight: 0, fConeBottomRadius: 0 },
      nWindowCount: windows.length,
      aWindows: padded(windows, MAX_WINDOWS, () => ({
        nConveyorId: 0,
        fStart: 0,
        fEnd: 0,
        eKind: E_VisuWindowKind.PICK,
      })),
    },
    stState: {
      nTimestamp: spec.timestamp ?? 0n,
      aAxisPositions: padded(spec.axisPositions ?? [0, 0, 0], 4, () => 0),
      stActualTcp: { fX: 0, fY: 0, fZ: 0, fRz: 0 },
      stSetpointTcp: { fX: 0, fY: 0, fZ: 0, fRz: 0 },
    },
  };
}

export type MachineComponent =
  | { id: number; name: string; path: string; kind: "conveyor"; value: ST_VisuConveyor }
  | { id: number; name: string; path: string; kind: "delta"; value: ST_VisuDelta };

/** Registers a manifest and its components in an in-memory PLC. */
export function defineMachine(
  plc: InMemoryPlc,
  components: MachineComponent[],
  options: { protocolVersion?: number; configVersion?: number } = {},
): void {
  const entries: ST_VisuManifestEntry[] = components.map((c) => ({
    nId: c.id,
    eType: c.kind === "conveyor" ? E_VisuComponentType.CONVEYOR : E_VisuComponentType.DELTA,
    sName: c.name,
    sPath: c.path,
  }));
  const manifest: ST_VisuManifest = {
    nProtocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
    nConfigVersion: options.configVersion ?? 1,
    nCount: entries.length,
    aEntries: padded(entries, MAX_MANIFEST_ENTRIES, () => ({ nId: 0, eType: 0, sName: "", sPath: "" })),
  };
  plc.define(MANIFEST_PATH, PLC_TYPES.manifest, manifest);
  for (const c of components) plc.define(c.path, PLC_TYPES[c.kind], c.value);
}
