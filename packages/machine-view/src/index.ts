/**
 * @rpp/machine-view: what the visualisation and the configurator share (ADR 0019), and the only module either app
 * imports from it. A machine read from its PLC sources (the gateway connection, the sources on their timelines), the
 * machine scene built from it by the component kits and drawn by `SceneView` with the camera views, the rules both
 * apps apply to the machine (machine facts, names), the palette and the shared look (`@rpp/machine-view/styles.css`).
 * Neither app's own modules are known here.
 */

// The connection to the gateway and the PLC sources it reads.
export {
  GatewayConnection,
  STALE_AFTER_MS,
  defaultGatewayUrl,
  useStore,
  type ConnectionSnapshot,
  type MessageListener,
  type ParameterMessage,
  type SocketState,
} from "./gateway-connection";
export { GATEWAY_LOST, RENDER_DELAY_MS, Sources, isOnline, type SourceInfo } from "./sources";

// The machine scene and its 3D view.
export {
  buildMachineScene,
  componentKey,
  formatPointCopy,
  mcsToRenderer,
  measureChain,
  pointsCsv,
  rendererToMcs,
  type ComponentKey,
  type MachineScene,
  type SceneModel,
  type SceneSource,
  type SnapPoint,
  type SourcedFaults,
} from "./scene/scene-model";
export {
  SceneView,
  type CameraPose,
  type CameraPreset,
  type Layers,
  type MeasurePoint,
  type Selection,
} from "./scene/SceneView";
export { ViewControls } from "./ViewControls";
export { pickOnScreen, type Projection } from "./scene/picking";
// The per-frame structure of the scene, for benchmarks of the view's frame cost.
export { MachineFrame, SourceFrame } from "./scene/scene-frame";
export { frameFromPose, toLocal, toMcs, type Vec3 } from "./scene/frames";

// Rules about the machine and names, the same in both apps.
export { faultText, isMissed, limitViolations, zoneSides, zoneWarnings } from "./machine-facts";
export { componentName, fieldLabel, singular } from "./naming";

// Look and page helpers.
export { OVERLAY, PRODUCT, STATUS, paletteCssVariables } from "./palette";
export { download } from "./download";
export { APP_VERSION } from "./version";
