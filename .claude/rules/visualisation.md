---
paths:
  - "apps/visualisation/**"
---

# Visualisation (`apps/visualisation`, served at `/`)

The live machine for operators and commissioning: 3D view, component tree, inspector, measuring, recordings.
`?embedded` drops title and status bar for a frame inside the machine HMI. View state: machine-view's
`useMachineView("rpp.view", DEFAULT_LAYERS)` (coordinate systems off by default).

## Seam: `Viewer` (`src/viewer.ts`)

What the user is looking at, live or a recording in playback, and the `SceneFeed` the 3D view and the inspector read
(it hands on to machine-view's `LiveMachine` or the `Player`; `SceneFeed` extends `InspectorFeed`). It holds the mode,
the shown sources, the replay buffer, the live recording with its 10 min limit, the shown recording and whether it is
saved, and the commands: record, stop, replay, open, save, discard, live / playback. One recording at a time; an
unsaved one is discarded only after `confirmDiscard`. It reads the live machine through `LiveFeed` (a fake in tests).
`RecordingControls.tsx` only binds it to the page (`useRecordingControls`: bar, files, downloads, leave guard).

## Seam: recording (`src/recording.ts`, ADR 0006)

- `Recorder` stores every gateway message with its arrival time (unchanged products dropped, gzip blocks of 1 s,
  10 min limit). `Recording.view(t)` gives every source at moment `t` as the machine scene takes it; `toFile` /
  `fromFile` round-trip a file; recordings store states in register form (ADR 0013).
- `Recording.events` are the timeline events found while recording (`timeline-events.ts`: a fault appears, a source
  goes offline or comes back, a product is missed, a limit violation starts, a machine message appears), using the
  same rules as the scene (`isMissed`, `limitViolations`); marked on the timeline, reached by click or PageUp/PageDown.
- The playback clock (`tick`, `seek`, `step`, `playFrom`) is pure. `player.ts` plays a recording as a `SceneFeed`; its
  clock moves on with `frame(now)`, called once per drawn frame.
- The replay buffer (ADR 0011) is a `Recorder` in replay-buffer mode (`Recorder.replayBuffer()`, 60 s before its newest
  message, whole blocks dropped), fed every message from page load; `snapshot()` gives the kept blocks as an ordinary
  recording starting at 0.

## Product history and metrics

Live from machine-view's `LiveMachine`, in playback from `Recording.products` up to the playback moment; both reach
the inspector through the `SceneFeed`.
