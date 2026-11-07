import { ProductGroups, type ProductGroup } from "./product-groups";
import { SCENE_PARTS, emptyScene, sceneStructure, type MachineScene, type SceneModel, type SceneProduct } from "./scene-model";

/**
 * What the 3D view needs to know about each new scene before drawing it: whether the set of drawn objects changed (so
 * React has to re-render), and where each object is in this frame. Pure: the view feeds it one scene per frame.
 */

/** Kinds of scene part the view looks up by key every frame; their `SCENE_PARTS` entry has a `key`. */
export type KeyedKind = "deltas" | "gantries" | "loops" | "cartesians" | "bodies" | "fingers" | "faultLabels";

/** One source's scene, frame by frame. */
export class SourceFrame {
  private readonly groups = new ProductGroups();
  private current: SceneModel = emptyScene();
  private signature: string | undefined;
  private readonly indexes = new Map<KeyedKind, Map<string | number, unknown>>();
  /** Per product group the products it draws this frame, in order. */
  members = new Map<string, SceneProduct[]>();
  /** The products drawn one by one this frame, by key. */
  single = new Map<string, SceneProduct>();
  /** The product groups as of the last structural change, each with the instances allocated to it. */
  productGroups: ProductGroup[] = [];

  /** This frame's scene. */
  get scene(): SceneModel {
    return this.current;
  }

  /** Takes this frame's scene; true when the drawn objects changed and the view has to re-render. */
  next(scene: SceneModel): boolean {
    this.current = scene;
    this.indexes.clear();
    const { groups, members, single } = this.groups.update(scene.products);
    this.members = members;
    this.single = single;
    const signature = `${sceneStructure(scene)}|${groups.map((g) => `${g.key}:${g.capacity}`).join(",")}`;
    if (signature === this.signature) return false;
    this.signature = signature;
    this.productGroups = groups;
    return true;
  }

  /** Makes the next scene count as changed, e.g. after a new config, which may change geometry but not ids. */
  invalidate(): void {
    this.signature = undefined;
  }

  /** A part of this frame's scene by its key (`SCENE_PARTS`), e.g. a Delta by its id. */
  part<K extends KeyedKind>(kind: K, key: string | number): SceneModel[K][number] | undefined {
    let index = this.indexes.get(kind);
    if (!index) {
      const keyOf = SCENE_PARTS[kind].key as (part: unknown) => string | number;
      index = new Map((this.current[kind] as unknown[]).map((p) => [keyOf(p), p]));
      this.indexes.set(kind, index);
    }
    return index.get(key) as SceneModel[K][number] | undefined;
  }
}

/** What changed in the machine scene since the previous frame. */
export interface MachineChanges {
  /** Across sources: which sources there are and whether they are online, snap points, origins, camera bounds. */
  structure: boolean;
  /** The faults of any component. */
  faults: boolean;
}

/** The whole machine's scene, frame by frame. */
export class MachineFrame {
  private current: MachineScene = { sources: [], snapPoints: [], origins: [], faults: [] };
  private signature: string | undefined;
  private faultKey: string | undefined;

  get scene(): MachineScene {
    return this.current;
  }

  next(scene: MachineScene): MachineChanges {
    this.current = scene;
    const signature = [
      scene.sources.map((s) => `${s.sourceId}:${s.online}:${s.scene.conveyors.length}:${s.scene.deltas.length}`).join(","),
      scene.snapPoints.filter((p) => !p.moving).map((p) => p.key).join(","),
      scene.origins.map((o) => `${o.sourceId}:${o.componentId}`).join(","),
    ].join("|");
    const faultKey = JSON.stringify(scene.faults);
    const changes = { structure: signature !== this.signature, faults: faultKey !== this.faultKey };
    this.signature = signature;
    this.faultKey = faultKey;
    return changes;
  }

  /** One source's scene of this frame; undefined for a source it does not have. */
  source(sourceId: string): SceneModel | undefined {
    return this.current.sources.find((s) => s.sourceId === sourceId)?.scene;
  }
}
