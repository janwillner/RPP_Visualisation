import type { Configurator } from "./configurator";
import type { NodeKey, SourceTopology, TopologyNodeView } from "./topology";

/**
 * A PLC's topology (ADR 0023), read-only: the nodes in use as a tree from the root node, the nodes not in use below
 * it. A click selects a node and the first of its components the draft has.
 */
export function TopologyTree(props: {
  topology: SourceTopology;
  sourceName: string;
  selected: NodeKey | undefined;
  configurator: Configurator;
}) {
  const { topology, selected, configurator } = props;
  const item = (node: TopologyNodeView) => {
    const isSelected = selected?.sourceId === topology.sourceId && selected.id === node.id;
    return (
      <li key={node.id}>
        <button className={isSelected ? "selected" : ""} onClick={() => configurator.selectNode(topology.sourceId, node.id)}>
          {node.name} <span className="muted">{node.kind}</span>
        </button>
        {node.children.length > 0 && <ul className="tree topology">{node.children.map(item)}</ul>}
      </li>
    );
  };
  return (
    <section aria-label={`Topology of ${props.sourceName}`}>
      <h3>Topology · {props.sourceName}</h3>
      {topology.root ? <ul className="tree topology">{item(topology.root)}</ul> : <p className="muted">The root node is not declared.</p>}
      {topology.notInUse.length > 0 && (
        <>
          <h4 className="muted">Not in use</h4>
          <ul className="tree topology not-in-use">{topology.notInUse.map(item)}</ul>
        </>
      )}
    </section>
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
