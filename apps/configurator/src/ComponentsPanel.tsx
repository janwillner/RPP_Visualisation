import { type ReactNode, useState } from "react";
import type { ComponentKey } from "@rpp/machine-view";
import type { DraftTree, TreeComponent, TreeNode } from "./draft-tree";
import type { Configurator } from "./configurator";
import type { NodeKey, TopologyNodeView } from "./topology";

/** Where the nodes folded in are remembered on this device. */
const FOLDED_KEY = "rpp.configurator.tree.folded";

function readFolded(): Set<string> {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/**
 * The draft's components along their PLCs' topologies (ADR 0023), read-only: per PLC its nodes in use from the root
 * node, each component under the node that stands for it (a node of one component is one row), the nodes not in use
 * below; a PLC without a topology lists its components flat; the components no node stands for come last. A component
 * only the PLC has is dimmed, with "Add". A click on a node selects it and the first of its components in the draft.
 */
export function DraftTreeView(props: {
  tree: DraftTree;
  selection: ComponentKey | undefined;
  selectedNode: NodeKey | undefined;
  configurator: Configurator;
  /** How a component in the draft stands against its PLC and its last write. */
  badges: (key: ComponentKey) => ReactNode;
}) {
  const { tree, selection, selectedNode, configurator, badges } = props;
  const [folded, setFolded] = useState(readFolded);
  const toggle = (id: string) => {
    const next = new Set(folded);
    if (!next.delete(id)) next.add(id);
    setFolded(next);
    try {
      localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
    } catch {
      // Not remembered then; the tree still folds.
    }
  };

  const add = (c: TreeComponent) => (
    <button
      className="add"
      aria-label={`Add ${c.name}`}
      title="Take this component from its PLC into the draft"
      onClick={() => configurator.importComponent(c.key)}
    >
      Add
    </button>
  );
  const componentRow = (c: TreeComponent) => (
    <li key={c.key} className={c.inDraft ? undefined : "plc-only"}>
      <div className="row">
        <span className="fold" />
        {c.inDraft ? (
          <button className={c.key === selection ? "selected" : ""} onClick={() => configurator.select(c.key)}>
            {c.name} <span className="muted">#{c.id}</span>
            {badges(c.key)}
          </button>
        ) : (
          <>
            <span className="name">
              {c.name} <span className="muted">#{c.id}</span>
            </span>
            {add(c)}
          </>
        )}
      </div>
    </li>
  );
  const nodeRow = (n: TreeNode): ReactNode => {
    const id = `${n.node.sourceId}#${n.node.id}`;
    // A node of one component is one row; with several they are listed below it.
    const one = n.components.length === 1 ? n.components[0] : undefined;
    const below = [...(one ? [] : n.components.map(componentRow)), ...n.children.map(nodeRow)];
    const open = !folded.has(id);
    const isSelected = selectedNode?.sourceId === n.node.sourceId && selectedNode.id === n.node.id;
    return (
      <li key={id} className={one && !one.inDraft ? "plc-only" : undefined}>
        <div className="row">
          {below.length > 0 ? (
            <button className="fold" aria-expanded={open} aria-label={`${open ? "Fold" : "Unfold"} ${n.name}`} onClick={() => toggle(id)}>
              {open ? "▾" : "▸"}
            </button>
          ) : (
            <span className="fold" />
          )}
          <button className={isSelected ? "selected" : ""} onClick={() => configurator.selectNode(n.node.sourceId, n.node.id)}>
            {n.name} <span className="muted">{n.kind}</span>
            {one && (
              <>
                {one.name !== n.name && ` · ${one.name}`} <span className="muted">#{one.id}</span>
                {one.inDraft && badges(one.key)}
              </>
            )}
          </button>
          {one && !one.inDraft && add(one)}
        </div>
        {below.length > 0 && open && <ul className="tree topology">{below}</ul>}
      </li>
    );
  };

  const empty = tree.withoutNode.length === 0 && tree.sources.every((s) => s.nodes.length + s.components.length + s.notInUse.length === 0);
  return (
    <div className="components">
      <h3>Components</h3>
      {empty && <p className="muted">None yet: import them from a PLC, or open a draft.</p>}
      {tree.sources.map((s) => (
        <section key={s.sourceId} aria-label={`Components of ${s.name}`}>
          <h4>{s.name}</h4>
          <ul className="tree topology">
            {s.nodes.map(nodeRow)}
            {s.components.map(componentRow)}
          </ul>
          {s.notInUse.length > 0 && (
            <>
              <h5 className="muted">Not in use</h5>
              <ul className="tree topology not-in-use">{s.notInUse.map(nodeRow)}</ul>
            </>
          )}
        </section>
      ))}
      {tree.withoutNode.length > 0 && (
        <section aria-label="Components without node">
          {tree.sources.length > 0 && <h4>Without node</h4>}
          <ul className="tree topology">{tree.withoutNode.map(componentRow)}</ul>
        </section>
      )}
    </div>
  );
}

/** The selected node's parent and links, as the PLC links them now. */
export function NodeDetails({ node }: { node: TopologyNodeView }) {
  return (
    <section className="node-details" aria-label={`Topology node ${node.name}`}>
      <h3>
        {node.name} <span className="muted">{node.kind}</span>
      </h3>
      <p className="muted">{node.inUse ? "In use" : "Not in use"}</p>
      <dl>
        <dt>Parent</dt>
        <dd>{node.parent?.name ?? <span className="muted">none</span>}</dd>
        {node.links.map((l) => (
          <div key={`${l.role}:${l.target.id}`}>
            <dt>{l.role}</dt>
            <dd>{l.target.name}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
