# Recordings are made and played back in the browser

A service technician records the machine's motion to look at it again afterwards, slowed down or frame by frame. The browser that presses "Record" keeps the recording itself. It stores every message from the gateway, all sources with config, status and state, together with its arrival time. Playback feeds this into the same machine scene as live data. The gateway stays read-only and does not change.

The live data is large: about 30 states per second of roughly 60 KB JSON each, mostly product registers, which is about 100 MB per minute. A state is larger than gzip's 32 KB window, so compressing the JSON alone saved only a factor of 8. The recorder therefore keeps, per conveyor, only the products that changed since the source's previous state, plus the order of the register, and compresses blocks of one second each. Every block starts complete, so it can be read on its own when playback jumps to it. Measured on the demo, this comes to about 1.6 MB per minute. A recording is limited to 10 minutes and stops by itself at that point. It can be saved as a file and opened again elsewhere.

## Considered Options

- **Record in the gateway, on the IPC's disk.** This would allow long recordings that survive a page reload and can be shared between clients. But the browser would need to send commands over the WebSocket, which is read-only today, and recordings would need managing on the IPC.
- **Gzip only, without dropping unchanged products.** Simpler, but about 13 MB per minute, too much for a panel PC.
- **Always keep the last minute, so a recording can start in the past.** This costs CPU for compression even when nobody records. It is deferred. (Later done as the replay buffer, ADR 0011.)

## Consequences

- A recording lives only in its browser tab; it is lost on reload unless saved. The page warns before closing while a recording is unsaved.
- The recording file (`.rpprec`) is gzip-compressed JSON lines with a format and protocol version. Files of another version are refused; there is no conversion.
- Embedded in TwinCAT HMI, the browser control may block downloads; saving then works only in a normal browser.
- While recording, the browser also derives the timeline events and the product history (with the product events the metrics count) from the messages. They are kept uncompressed next to the blocks, a few hundred bytes per product, and are not part of the file: opening a file derives them again from its messages, so older files get them too.
