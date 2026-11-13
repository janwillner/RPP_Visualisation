import { ConfigEmulation } from "../src/config-emulation";
import { InMemoryPlc } from "../src/in-memory-plc";
import {
  body,
  cartesian,
  conveyor,
  defineMachine,
  defineMachineEntry,
  machineMessage,
  delta,
  detector,
  fingerStates,
  loopModules,
  station,
  xtsGantry,
  xtsLoop,
} from "../src/plc-builders";
import {
  E_VisuBodyRole,
  E_VisuBodyShape,
  E_VisuCartesianAxes,
  E_VisuMessageSeverity,
  E_VisuProductShape,
  E_VisuProductState,
  E_VisuRunState,
  type ST_VisuConveyor,
} from "../src/plc-contract";

/** The fixture's source id in every message. */
export const FIXTURE_SOURCE = "fixture";

const INFEED = { id: 1, path: "MAIN.stInfeed" };
const OUTFEED = { id: 2, path: "MAIN.stOutfeed" };
const DELTA = { id: 10, path: "MAIN.stDelta1" };
/** Clients that changed products on the infeed last. */
const VISION_ID = 50;
const REJECT_UNIT_ID = 60;

/**
 * A fixed machine for the gateway tests that need a whole one (docs page, web pages, WebSocket commands): one
 * component of every type with the optional parts filled (fingers, limit areas, origin shifts, bodies, zones on a
 * lane), products in every state and of every shape on the infeed, one of them marked, faults on a component, a mover
 * and a track module. Syn_Config holds parameter sets of the infeed and Delta 1 (ADR 0017); `step` is one PLC cycle of
 * it. Nothing moves: what the gateway reads is the same in every cycle but the infeed's timestamp.
 */
export function fixtureMachine() {
  const plc = new InMemoryPlc();
  const fault = (sMessage: string) => ({ bActive: true, sMessage });
  const products = [
    { state: E_VisuProductState.DETECTED, previous: E_VisuProductState.DETECTED, client: VISION_ID, type: 1, mark: 1 },
    { state: E_VisuProductState.ASSIGNED, previous: E_VisuProductState.DETECTED, client: DELTA.id, type: 2, mark: 0 },
    { state: E_VisuProductState.PICKED, previous: E_VisuProductState.ASSIGNED, client: DELTA.id, type: 3, mark: 0 },
    { state: E_VisuProductState.PLACED, previous: E_VisuProductState.PICKED, client: DELTA.id, type: 1, mark: 2 },
    { state: E_VisuProductState.REJECTED, previous: E_VisuProductState.PLACED, client: REJECT_UNIT_ID, type: 1, mark: 0 },
  ];
  defineMachine(
    plc,
    [
      {
        id: INFEED.id,
        name: "Infeed",
        path: INFEED.path,
        kind: "conveyor",
        value: conveyor({
          pose: { fZ: 800 },
          length: 3000,
          originShift: { fX: -100 },
          productTypes: [
            { nId: 1, fLength: 120, fWidth: 80, fHeight: 40 },
            { nId: 2, fLength: 80, fWidth: 60, fHeight: 40, eShape: E_VisuProductShape.CYLINDER },
            { nId: 3, fLength: 120, fWidth: 80, fHeight: 40, eShape: E_VisuProductShape.ROUNDED_BOX, fCornerRadius: 10 },
          ],
          // Past the belt end, the last one is missed.
          products: [...products, { state: E_VisuProductState.DETECTED, previous: E_VisuProductState.DETECTED, client: VISION_ID, type: 1, mark: 0 }].map(
            (p, i) => ({
              nId: i + 1,
              stLatchPose: { fX: i === products.length ? 3100 : 200 + i * 300, fY: 0, fZ: 0, fRz: 0 },
              eState: p.state,
              ePreviousState: p.previous,
              nLastClientId: p.client,
              nProductType: p.type,
              nMark: p.mark,
              nFingerId: p.state === E_VisuProductState.PICKED ? 1 : 0,
            }),
          ),
        }),
      },
      { id: OUTFEED.id, name: "Outfeed", path: OUTFEED.path, kind: "conveyor", value: conveyor({ pose: { fY: 900, fZ: 800 }, body: false }) },
      {
        id: DELTA.id,
        name: "Delta 1",
        path: DELTA.path,
        kind: "delta",
        value: delta({
          pose: { fX: 1500, fY: 450, fZ: 1900 },
          fingers: [{ fDiameter: 40, fHeight: 50 }],
          limitArea: { fXMin: -600, fXMax: 600, fYMin: -600, fYMax: 600, fZMin: -1500, fZMax: -700 },
          tcpLimitArea: { fXMin: -80, fXMax: 80, fYMin: -80, fYMax: 80, fZMin: -100, fZMax: 20 },
          zones: [
            { nConveyorId: INFEED.id, fStart: 1100, fEnd: 1900, fAllocationOffset: 300, fCcsOffset: 1500 },
            { nConveyorId: OUTFEED.id, fStart: 1200, fEnd: 1800, fStartY: -100, fEndY: 100 },
          ],
          fault: fault("Axis 2: following error"),
        }),
      },
      {
        id: 30,
        name: "IDH",
        path: "MAIN.stIdh",
        kind: "xtsGantry",
        value: xtsGantry({
          pose: { fX: 3500, fZ: 1500 },
          fingers: [{ fDiameter: 40, fHeight: 50 }],
          limitArea: { fXMin: 0, fXMax: 700, fYMin: -50, fYMax: 800, fZMin: -600, fZMax: -300 },
          tcpLimitArea: { fXMin: -60, fXMax: 60, fYMin: -85, fYMax: 85, fZMin: -100, fZMax: 20 },
          movers: [
            { nId: 1, fPosition: 100, aFingerStates: fingerStates([{ bActive: true }]) },
            { nId: 2, fPosition: 400, stFault: fault("Mover 2: position lag") },
          ],
        }),
      },
      {
        id: 20,
        name: "Fxx",
        path: "MAIN.stFxx",
        kind: "xtsLoop",
        value: xtsLoop({
          pose: { fX: 5000, fZ: 1000 },
          modules: loopModules(4),
          moduleFaults: [undefined, fault("Module 2: overtemperature")],
          movers: [{ nId: 1, fPosition: 300 }],
        }),
      },
      {
        id: 40,
        name: "Cartesian",
        path: "MAIN.stCartesian",
        kind: "cartesian",
        value: cartesian({
          axes: E_VisuCartesianAxes.XZ,
          pose: { fX: 7000, fZ: 1500 },
          fingers: [{ fDiameter: 40, fHeight: 40, stOffset: { fZ: -110 } }],
          state: { fX: 300, fZ: -200, bGripperActive: true },
        }),
      },
      {
        id: VISION_ID,
        name: "Vision 1",
        path: "MAIN.fbVision.vo_Visu",
        kind: "vision",
        value: detector({
          pose: { fX: 300, fZ: 1600 },
          zones: [{ nConveyorId: INFEED.id, fStart: 100, fEnd: 500, fCcsOffset: 300 }],
          bodies: [
            body({ fLength: 200, fWidth: 150, fHeight: 100 }),
            body({ eShape: E_VisuBodyShape.FRUSTUM, eRole: E_VisuBodyRole.FIELD_OF_VIEW, fLength: 50, fWidth: 50, fHeight: 800, fTopLength: 400, fTopWidth: 400 }),
          ],
          active: [false, true],
        }),
      },
      {
        id: 51,
        name: "Light barrier",
        path: "MAIN.fbSensor.vo_Visu",
        kind: "sensor",
        value: detector({
          pose: { fX: 600, fY: -250, fZ: 820 },
          bodies: [body({ eShape: E_VisuBodyShape.CYLINDER, eRole: E_VisuBodyRole.BEAM, fLength: 6, fWidth: 6, fHeight: 500 })],
        }),
      },
      {
        id: REJECT_UNIT_ID,
        name: "Reject unit",
        path: "MAIN.fbRejectUnit.vo_Visu",
        kind: "station",
        value: station({ pose: { fX: 2400, fY: 670 }, bodies: [body()], fault: fault("Pusher not in its end position") }),
      },
    ],
    { markNames: ["Sample"] },
  );
  // The machine entry (protocol 22): a run state, simulation mode, a message about Delta 1 and a gone one.
  defineMachineEntry(plc, {
    eRunState: E_VisuRunState.RUNNING,
    sRunStateText: "Production",
    bSimulation: true,
    messages: [
      machineMessage({ nId: 101, eSeverity: E_VisuMessageSeverity.ERROR, sText: "Vacuum lost", nTime: 1_000_000n, nComponentId: DELTA.id }),
      machineMessage({ nId: 7, eSeverity: E_VisuMessageSeverity.INFO, sText: "Door closed", nTime: 500_000n, bActive: false }),
    ],
  });
  const config = new ConfigEmulation(plc, [
    { id: INFEED.id, kind: "conveyor", path: "MAIN.fbInfeedConfig.vo_Config", visuPath: INFEED.path },
    { id: DELTA.id, kind: "delta", path: "MAIN.fbDelta1Config.vo_Config", visuPath: DELTA.path },
  ]);
  const infeed = plc.get<ST_VisuConveyor>(INFEED.path);
  let cycle = 0;
  return {
    plc,
    config,
    /** One PLC cycle of 20 ms: the timestamps move on, the belt does not. */
    step(): void {
      cycle += 1;
      infeed.stState.nTimestamp = BigInt(cycle) * 20_000_000n;
      config.step();
    },
  };
}
