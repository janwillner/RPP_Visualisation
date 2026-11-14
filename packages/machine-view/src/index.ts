/**
 * @rpp/machine-view: what the visualisation and the configurator share (ADR 0019), and the only module either app
 * imports from it. A machine read from its PLC sources (the gateway connection, the sources on their timelines), the
 * machine scene built from it by the component kits and drawn by `SceneView` with the camera views, the rules both
 * apps apply to the machine (machine facts, names), the panels the apps share (component tree, inspector with the
 * product history and the metrics, status bar, top bar), the palette and the shared look
 * (`@rpp/machine-view/styles.css`). Neither app's own modules are known here.
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
// The live machine with its product history, and the parameter sets and recipes with the commands on them.
export { LiveMachine } from "./live-machine";
export { GatewayLive, writeKey, type LiveCommand, type LiveConnection, type LiveSnapshot, type TrackedWrite } from "./gateway-live";

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
export { LayerToggles } from "./LayerToggles";
export { SidePanelControls, sidePanelsLayout, useSidePanel, type SidePanel } from "./SidePanels";
export { pickOnScreen, type Projection } from "./scene/picking";
// The per-frame structure of the scene, for benchmarks of the view's frame cost.
export { MachineFrame, SourceFrame } from "./scene/scene-frame";
export { frameFromPose, toLocal, toMcs, type Vec3 } from "./scene/frames";

// Rules about the machine and names, the same in both apps.
export {
  activeMachineMessages,
  dcTimeOfDay,
  faultText,
  isMissed,
  limitViolations,
  machineMessagePlace,
  machineMessageText,
  markName,
  productMark,
  runStateText,
  zoneSides,
  zoneWarnings,
} from "./machine-facts";
export { componentName, fieldLabel, singular } from "./naming";

// What happened to the products, the figures counted from it, and a component state's values and tables.
export { ProductHistory, type ProductEvent, type ProductStep } from "./product-history";
export { METRICS_WINDOW_MS } from "./metrics";

// The panels the apps share.
export { ComponentTree } from "./panels/ComponentTree";
export { Inspector, sourceScene, type InspectorFeed } from "./panels/Inspector";
export { StatusBar, offlineSources } from "./panels/StatusBar";
export { StatusList, type StatusItem } from "./panels/StatusList";
export { TopBar } from "./panels/TopBar";
export { NumberInput, TextInput } from "./inputs";
export { useTick } from "./use-tick";

// Look and page helpers.
export { MARK, OVERLAY, PRODUCT, STATUS, paletteCssVariables } from "./palette";
export { download } from "./download";
export { APP_VERSION } from "./version";
