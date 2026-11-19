# Topology declared by the application, set by the configurator, applied at the next start

An application such as RPL6 links its parts in code: every part gets a parent (cell, main machine), a pick-and-place
handling gets its infeed and discharge transports and its vacuum supply, a vision unit gets the transport it looks at
(`CONX_Context_CfgInit`, one link table of context, role and target, applied while the state machines are in
SYS_INIT). The aim is one PLC program for the full build-out of a product line, and per machine only the configurator
deciding which parts are **in use** and how they are linked.

So, in the library Syn_Config (config protocol 5):

- **The application declares its topology.** One topology FB per application, `_FB_ConfigTopology`, with its own
  entry in the config manifest, declares its **topology nodes** (id, name, kind, and the manifest ids of the
  components a node stands for, if any), its **roles** (name, the node kind that holds it, the node kinds it may point
  to, required or optional) and its **root node**. The gateway reads the declaration at discovery. The configurator
  knows no RPP kinds: its tree, its choices and its checks come from the declaration, like the Simulator's form from
  the recipe fields (ADR 0022). Fixed sizes: 64 nodes, 16 roles, 128 links.
- **The links are the truth.** The configurator sets every link explicitly; the application's default links
  (`m_DefaultParent`, `m_PphDefault`, `m_DetDefault`) stay allowed only in its program values. A zone's conveyor
  follows its robot's or detector's links: the configurator offers only the linked conveyors and moves the zones along
  when a link changes. The zone's structure does not change, so machines without a topology choose freely as before.
- **In use is derived, not flagged.** A node is in use when it is the root node or its chain of parents reaches it;
  a node that drops out takes its children with it. Only links of nodes in use are written, and a link of a node in
  use to a node not in use is an error. There is no "installed" flag beside the parent link.
- **Taken over at any time, applied at the next start.** The staging of the parameter sets (ADR 0017) is reused, but
  a staged topology that passes its checks becomes **pending**: kept persistent and linked at the next SYS_INIT. The
  FB reports the active version (linked at the last start) and the pending one; the configurator shows "restart
  needed". While none was written, and after a reset, the application's program values apply: its `CfgInit` code.
- **The PLC registers the full build-out.** Every component of every node stays in the manifest. The visualisation
  and the Simulator hide the components of nodes not in use in the active topology; the configurator shows them faded
  and adds a node's components to the draft when it gets a parent, and removes them when it loses it.

## Considered Options

- **Show and check only**, the links staying in code: no change to the start-up of the application, but a machine
  would still need its own program for every build-out.
- **Re-linking at run time while stopped**: no restart, but every subunit's `CfgInit` takes its hardware from its
  links once, so the whole state machine tree would have to go back through SYS_INIT; too deep a change for now.
- **The RPP roles and kinds fixed in the library and the TypeScript side**: quicker, but would tie the visualisation
  to one application, against the rest of its contract.
- **A zone naming a role instead of a conveyor**: one truth by construction, but a breaking change of the zones in
  Syn_Visu and Syn_Config for every machine, also those without a topology.
- **Registering only the components in use**: smaller manifest, but the configurator would not know the hardware of
  a node it is about to take into use.
- **Roles and links on `_FB_ConfigMachine`**: one FB less, but its status would mean "applied" for the recipe and
  "pending until restart" for the topology.

## Consequences

- What the PLC does with the hardware of nodes not in use (missing EtherCAT boxes and drives) is the application's
  business and still open (`docs/status.md`).
- The RPP application has to load its link table from `_FB_ConfigTopology` and switch off the state machines of nodes
  not in use; it needs a reference to the Syn_Config library, which it does not have today.
