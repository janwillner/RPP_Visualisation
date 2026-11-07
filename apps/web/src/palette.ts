/**
 * Every colour of the 3D view and the status colours of the panels around it, in one place. The panels read the
 * status colours as CSS variables (`paletteCssVariables`), so a marker on the timeline, a line in the tree and the
 * part in the 3D view always agree.
 *
 * Chosen for a dark background and for red-green colour blindness: status colours that must not be confused also
 * differ in lightness (fault: medium red; pick and gripping: light green; missed: pink, apart from fault red by its
 * blue part).
 */

/** States and events: the same meaning everywhere in the app. */
export const STATUS = {
  fault: "#ef4444",
  /** Fault text on the dark panels. */
  faultText: "#ff7b7b",
  /** Background of a fault message in the 3D view. */
  faultLabel: "#c62828",
  select: "#ffd54f",
  missed: "#ff5fa2",
  offline: "#ffa726",
  online: "#5fd39a",
  /** Interface accent; also the working areas. */
  accent: "#4fc3f7",
} as const;

/** Products by register state; a missed product shows `STATUS.missed`. */
export const PRODUCT = {
  detected: "#a9bbd3",
  assigned: "#f5a524",
  picked: "#5fd39a",
  rejected: "#a78bfa",
  placed: "#2fc6d6",
} as const;

/**
 * Overlays: areas, zones and markers that explain the machine rather than show it. They are drawn unlit and
 * without tone mapping, so they keep exactly these colours however the scene is lit.
 */
export const OVERLAY = {
  workingArea: STATUS.accent,
  limitArea: "#ff9800",
  /** Every zone alike, whatever its component does there. */
  zone: "#5fd39a",
  allocation: "#22a86b",
  /** Detector bodies with these roles; they light up when active. */
  beam: "#ffd54f",
  fieldOfView: "#4fc3f7",
  /** The conveyor coordinate system line on a belt; apart from the zone greens and the rejected violet. */
  ccs: "#b388ff",
  setpoint: "#ffee58",
  snapPoint: "#ffffff",
  xtsTool: "#ffb74d",
} as const;

/** Coordinate axes: X red, Y green, Z blue, as in every CAD tool. */
export const AXES = { x: "#ef5350", y: "#66bb6a", z: "#42a5f5" } as const;

/** Lit machine parts: matte, light enough to stand out from the dark background. */
export const SOLID = {
  belt: "#3b4656",
  /** Large selected parts (belts, beams, rails) in a muted selection colour, so overlays on them stay readable. */
  selectedStructure: "#8a7a3a",
  beltArrow: "#c3ccd8",
  aluLight: "#d9dee5",
  aluMid: "#a9b3c0",
  aluDark: "#8e99a8",
  profile: "#6a7686",
  dark: "#4f5a69",
  motor: "#353c47",
  gripper: "#3d8fe0",
  gripperActive: STATUS.online,
  /** A detector's sensing part, e.g. a camera lens or a light barrier head. */
  sensor: "#26c6da",
  /** A machine part a component reports as active, e.g. a reject unit's pusher while it rejects. */
  bodyActive: STATUS.online,
  /** Fine outline along the edges of solid parts. */
  edge: "#0b0e12",
} as const;

/** The stage around the machine. */
export const STAGE = {
  backgroundTop: "#2c3441",
  backgroundBottom: "#12151a",
  floor: "#232a33",
  gridCell: "#303845",
  gridSection: "#4a5668",
} as const;

/** The status colours for the panels, as CSS custom properties. */
export function paletteCssVariables(): Record<string, string> {
  return {
    "--accent": STATUS.accent,
    "--ok": STATUS.online,
    "--bad": STATUS.fault,
    "--bad-text": STATUS.faultText,
    "--fault-label": STATUS.faultLabel,
    "--select": STATUS.select,
    "--missed": STATUS.missed,
    "--offline": STATUS.offline,
    "--stage-top": STAGE.backgroundTop,
    "--stage-bottom": STAGE.backgroundBottom,
  };
}
