# Products name the client that changed them last, with the state before

Until protocol 12 a product had two references to components: `nRobotId`, the robot it was assigned to, picked or placed by, and `nDetectorId`, the detector that latched it. A station that works on products, such as a reject unit, had neither, and every new kind of client would have needed another field on every product in every register.

From protocol 13 a product names one client: `nLastClientId`, the component that made the last change (the detector or station that latched it, the robot that is assigned to, picks, places or releases it, the station that rejects it), and `ePreviousState`, its state before that change. `m_LatchProduct` and `m_SetProductState` take one `vi_udn_ClientId`. The web app follows the products through the snapshots anyway (product history, metrics), so it learns who did what from the changes: "detected by Vision 1", "picked by Delta 1", "rejected by Reject unit", and the metrics count per client and action without knowing the client's type. `ePreviousState` keeps a change readable when a snapshot in between was missed, e.g. "released" (back to detected after assigned) or a rejection seen without the state before it.

With it came the station (`ST_VisuStation`, `_FB_VisuStation`): a client drawn from its bodies like a detector (ADR 0007), but with its own structure, so the manifest type and the data type agree and stations can grow apart from detectors later.

## Considered Options

- **Keep `nRobotId` and `nDetectorId` and add `nStationId`.** No break for the applications, but one more field per client kind on every product, and the web would still need code per kind.
- **An event ring per product in the PLC.** Every change kept even within one gateway cycle, but much more data per product and more code in every application; the gateway cycle (20 ms) is short enough that two changes within it are rare, and `ePreviousState` covers the common case.
- **Reuse `nRobotId` as "acting component" for stations.** No protocol change, but a field whose name says something else.

## Consequences

- Protocol 13 and library 6.0.0 break every application: `vi_udn_RobotId` and `vi_udn_DetectorId` become `vi_udn_ClientId`. Where a robot gives a product back (`DETECTED` again), it is now named as the client, not 0.
- A product no longer remembers which detector latched it once a robot has taken it over; the product history, which follows it over time, still shows it. Recordings of protocol 12 cannot be played back.
- The metrics show, per client, what it did per minute; a robot shows both its picks and its places.
