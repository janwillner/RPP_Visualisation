# The browser always keeps the last minute

A recording (ADR 0006) only starts when someone presses Record, and that is often after the moment worth seeing. So every browser tab now runs a replay buffer from the moment the page opens. It is a `Recorder` in replay-buffer mode that keeps the 1 s blocks of the last 60 s before its newest message and drops older ones whole. Every block starts complete, so nothing has to be compressed again. A button right of Record turns the kept blocks into an ordinary, unsaved recording, which plays, saves and opens like any other. The buffer goes on filling, also during playback and while a manual recording runs.

The minute counts back from the newest message, not from the click. After the gateway or a PLC drops out, the button therefore still gives the minute before the outage.

The replay buffer keeps no timeline events, product history or snapshot times, because these would grow without limit. `snapshot()` finds them again from the kept blocks, the way opening a file does, and shifts the times so that the recording starts at 0. This happens once per click and costs decompressing and recompressing about 60 blocks.

## Considered Options

- **Keep the minute in the gateway.** This would cover the time before anyone opened the page. But it needs compression and the file format in Node, a new endpoint, and buffers per IPC. Deferred.
- **A minute before the click instead of before the newest message.** After an outage this gives nothing.
- **A setting to switch the buffer off.** ADR 0006 deferred the buffer for the CPU cost of compressing while nobody records. It is about one gzip of a 1 s block per second, the same as recording, and the minute is worth it on every device. So there is no switch.

## Consequences

- Every tab compresses all the time and holds about 2 MB for the buffer.
- The buffer is lost on reload, like an unsaved recording. It never warns before closing; the recording made from it does until it is saved.
- The button is disabled while a manual recording runs (one recording at a time) and until the first message arrives. During playback it replaces the shown recording, after asking if that one is unsaved.
