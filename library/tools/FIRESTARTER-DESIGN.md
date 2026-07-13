# EMITR · FIRESTARTER — Design Spec

> A unified, clock-synced, jammy MIDI jam station. The drum machine and the arpeggiator,
> fused on ONE master clock, with scenes + savable arp clips you launch on the fly,
> live MIDI out into Ableton, and an interface built to start ideas faster than Ableton can.
> The flagship of the EMITR Observatory in-browser studio suite.

---

## 1. Concept

**Tagline:** One clock. Two engines. Infinite firestarters.

**Philosophy.** Ableton is where you *finish*; FIRESTARTER is where you *start*. The whole tool
is biased toward the first 30 seconds of an idea — trigger, don't configure. The drum sequencer
and the arpeggiator stop being two tabs in two windows and become one instrument breathing on a
single look-ahead clock, where a single playhead column sweeps across both grids in perfect
vertical alignment — the visual proof of the shared transport. You jam by launching pads
(scenes + arp clips), every launch is quantized to the bar so it *can't* sound wrong, and a
one-button **CAPTURE → SCENE** snapshots the live jam so a moment is never lost. MIDI streams
live into Ableton (app = clock master), so FIRESTARTER becomes the front-end groovebox and
Ableton becomes the rack of instruments and the recorder.

**Three hard truths the build is organized around:**
1. The timing backbone (one accumulator-based look-ahead scheduler at 96 PPQN) is the #1 thing
   that must be rock-solid. Drums and arp read the *same* tick accumulator, so they are
   *provably* unable to drift apart.
2. The engine talks ONLY to an abstract MIDI-SINK. `WebMidiSink` ships now (live note stream);
   `OscSink` is a documented phase-2 stub (clip-writer). The engine never changes between them.
3. The core (`firestarter-core.js`) is headless and Node-`require`-safe. All Web Audio / Web MIDI /
   DOM access is guarded, so the data + scheduler logic is unit-testable and `node --check`-clean.

---

## 2. Files & ownership

| File | Owner | What it is |
|------|-------|-----------|
| `firestarter-core.js` | core | Headless engine: master clock + look-ahead scheduler, transport, drum synth + sequencer, arp engine, scene/clip data model, MIDI-SINK abstraction (+ WebMidiSink + OscSink stub), file export (embeds verified `buildMidi`). Exposes `window.FIRESTARTER`. Node-`require`-safe. |
| `firestarter.html` | ui | Self-contained UI. Loads `<script src="firestarter-core.js">`, drives `window.FIRESTARTER`. Inline CSS + UI JS. External deps ONLY: Google Fonts + the core script. Opens by double-click (`file://`). |
| `FIRESTARTER-DESIGN.md` | — | This spec. |
| `SETUP-ABLETON.md` | — | macOS IAC Driver + Ableton MIDI-in + EXT-sync setup. |

**Reuse, don't reinvent.** Ported verbatim where pure:
- **Drums** from `drum-machine.html`: `VOICES` (12 GM voices, kick 36 … cowbell 56), `DRUM_CHANNEL=9`,
  `gatherNotes()`, the synth voice functions (`kick`/`snare`/…), and the `serialize/applySerialized/getBank/setBank`
  localStorage pattern.
- **Arp** from `arpeggiator.html`: `NOTE_NAMES`, `CHORD_TYPES`, `getChordBasePitches → getStackedPitches →
  buildArpCycle` (all 9 modes incl. updown/downup turning-point dedup), `stepLengthBeats()` (dotted/triplet),
  `resolveNotes()`, and the synth `playVoice` (2 detuned saws → lowpass+env → ADSR → delay send).
- What gets surgically removed from BOTH: their private `setTimeout` schedulers, `nextStepTime`, and
  `currentStep`. Neither engine owns time anymore — the core clock does, and both subscribe.

---

## 3. The clock & transport (LOCKED)

### 3.1 Tick is the atom; step is derived
The unifying primitive is the **PPQN tick, not the step**. Internal resolution is **96 PPQN**
(divisible by straight 16ths = 24 ticks, triplet 16ths = 16 ticks, triplet 8ths = 32 ticks, dotted
16ths = 36 ticks, AND an integer multiple of MIDI's 24-PPQN clock → 96/24 = 4). The drum sequencer
and the arp are *consumers*: each tick they decide whether this tick lands on one of *their* steps.
Neither owns `currentStep`; the clock owns time.

### 3.2 The look-ahead scheduler (against `AudioContext.currentTime`)
```
LOOKAHEAD_MS   = 25      // setTimeout cadence (timer ONLY — never schedules a note directly)
SCHEDULE_AHEAD = 0.10    // seconds of future we schedule into
PPQN           = 96
clk = { bpm, playing, tick, nextTickTime, ctx }

secPerTick() = (60 / bpm) / PPQN          // bpm read LIVE → tempo changes are glitch-free;
                                          // already-scheduled audio is committed, only future ticks use new value

function scheduler() {
  while (clk.nextTickTime < ctx.currentTime + SCHEDULE_AHEAD) {
    emitTick(clk.tick, clk.nextTickTime)
    clk.tick += 1
    clk.nextTickTime += secPerTick()      // accumulator pattern → zero drift
  }
  timer = setTimeout(scheduler, LOOKAHEAD_MS)
}
```
`emitTick(tick, time)` runs three steps **in order**, every tick:
1. **Commit launches** whose `boundaryTick <= tick` (scenes/clips swap here, sample-accurately).
2. **MIDI clock + raw `onTick` subscribers** — emit a 24-PPQN pulse when `tick % 4 === 0`.
3. **Derived `onStep` events** — drums + arp compute their own step index from the tick and fire.

### 3.3 Two consumers, one accumulator
- **Drums** act when `tick % (PPQN/4) === 0` (a 16th, every 24 ticks). Step = `(tick / 24) % drumSteps`.
- **Arp** holds `ticksPerArpStep = round(PPQN * stepLengthBeats())`. Acts when `tick % ticksPerArpStep === 0`.
  Step = `(tick / ticksPerArpStep) % arpClip.length`.

Because both read the same `clk.tick` accumulator, they are sample-locked by construction.

### 3.4 Shared swing
ONE global `swing` (0–70). Each consumer, when it decides "this is my step," adds
`swingOffsetSec = stepIsOdd ? (swing/100) * theirStepSec * 0.5 : 0` to `time` before sending. Identical
formula both engines already used — now sourced from one value.

### 3.5 Launch-quantization engine (serves scenes AND clips)
```
pendingLaunches = []   // { fn, boundaryTick, tag }
scheduleLaunch(fn, quantize) {       // quantize ∈ 'instant' | 1 | 2 | 4  (bars)
  if (quantize === 'instant') { fn(); return null }
  const ticksPerBar = PPQN * 4
  const span = ticksPerBar * quantize
  const boundaryTick = (Math.floor(clk.tick / span) + 1) * span
  const L = { fn, boundaryTick }
  pendingLaunches.push(L)
  return L                            // handle so UI can cancel + draw the countdown ring
}
// in emitTick step 1:
pendingLaunches = pendingLaunches.filter(L => {
  if (L.boundaryTick <= tick) { L.fn(); return false }  // commit exactly on boundary
  return true
})
```
Scene switches AND arp-clip switches both register here, so a jam *never* lands off-grid. The UI
reads `boundaryTick` vs `clk.tick` to draw the draining countdown ring.

### 3.6 Transport → MIDI
- `start()` → `tick=0`, `nextTickTime = ctx.currentTime + 0.06`, `sink.sendStart()`, start scheduler.
- per tick where `tick % 4 === 0` → `sink.sendClock(time)` (24 PPQN; app = master → Ableton follows).
- `stop()` → `sink.sendStop()`, clear timer + pending launches.
- `continue()` → `sink.sendContinue()`, resume from current tick.
- **Clock keeps emitting even when no notes play**, so Ableton's tempo display locks before the first note.

The clock calls ONLY the sink interface — never Web MIDI directly — so `OscSink` drops in untouched.

---

## 4. MIDI architecture

### 4.1 The MIDI-SINK interface (duck-typed; both impls expose these)
```js
{
  sendNoteOn(ch, note, vel, time),   // time = AudioContext-domain SECONDS (engine clock)
  sendNoteOff(ch, note, time),
  sendCC(ch, cc, val, time),
  sendClock(time),                   // one 24-PPQ pulse (0xF8)
  sendStart(time),                   // 0xFA
  sendStop(time),                    // 0xFC
  sendContinue(time),                // 0xFB
  ready()                            // bool — engine guards every live send on this
}
```
The engine schedules in `AudioContext.currentTime` **seconds**; Web MIDI `send(data, ts)` wants
`performance.now()` **milliseconds**. The sink converts at the boundary. ONE calibration offset is
captured at sink-enable — this single line is what makes synth + Ableton fire together:
```js
offset = performance.now() - audioCtx.currentTime * 1000   // captured in enable()
midiTimestamp = time * 1000 + offset                       // applied on every send
```

### 4.2 WebMidiSink (ships now — realtime note stream)
- `enable(audioCtx)` MUST be called from a user gesture; calls `navigator.requestMIDIAccess({sysex:false})`,
  captures the offset, wires `onstatechange` for hot-plug, populates outputs.
- `outputs()` → array for the dropdown; `select(id)` sets the active output and `_ready`.
- Note/CC/clock/transport methods send raw MIDI bytes at `time*1000 + offset`, guarded by `_ready`.
- Drums → channel index 9 (MIDI 10, GM map; voice notes already correct). Arp → `arpCh` (default 0 = MIDI 1).
- Every note send: `sendNoteOn` + a paired `sendNoteOff` scheduled at `time + durSec`.

### 4.3 OscSink (phase-2 stub — clip-writer, NOT a stream)
All methods no-op now; documents the AbletonOSC mapping so the contract is locked:
```
/live/song/start_playing · /live/song/set/tempo <bpm>
/live/clip_slot/create_clip <track> <slot> <length>
/live/clip/add/notes <track> <slot> <pitch> <start> <dur> <vel> <mute>
/live/clip/fire <track> <slot>     (Live does the launch-quantize itself)
```
Architectural note: `WebMidiSink` streams notes; `OscSink` *batches* the engine's
`{pitch,start,dur,vel}` tuples into a clip and flushes on scene-fire. The same interface covers both
because the engine's note-scheduling already produces those tuples. Transport methods become OSC
transport; note methods become buffered clip-note adds. **No engine rewrite.**

### 4.4 Graceful degradation
If `navigator.requestMIDIAccess` is undefined (Safari/Firefox/some `file://`) or permission is denied,
the MIDI strip shows `MIDI UNAVAILABLE — synth + .mid export still work`, the engine runs on a no-op
fallback sink, and nothing throws. Node `require` guards `typeof navigator/window/AudioContext`.

---

## 5. Data model (`localStorage` key `firestarter-v1` + JSON export/import)

```
Project {
  v: 1,
  bpm: 148,                       // ONE master tempo
  swing: 0,                       // shared global swing %
  launchQuant: 1,                 // bars to boundary: 'instant' | 1 | 2 | 4
  midi: { outId, drumCh:9, arpCh:0, clockEnabled:true, asMaster:true },
  drumClips: { [id]: DrumClip },  // SHARED POOLS — scenes reference clips by id
  arpClips:  { [id]: ArpClip },
  scenes: [ Scene, ... ],
  activeSceneId, queuedSceneId,
  liveDrumClipId, liveArpClipId,  // what's currently sounding (independent of scenes)
  lengthBars: 4
}

DrumClip {                        // = PULSE pattern, promoted to a launchable unit
  id, name, lengthBars, steps,    // steps = 16 * lengthBars
  pattern: { [voiceId]: Int[steps] },   // levels 0–3
  mute: {}, solo: {}, human: {}
}

ArpClip {                         // = ARP state, promoted; length up to 256 steps (8–16 bars)
  id, name, lengthBars,           // 1–16 bars
  root, type, octaves, mode, rate, gate, cutoff, hold, customNotes:[],
  steps,                          // lengthBars-derived step count
  pattern: Bool[steps], velocities: Int[steps],
  channel: 1
}

Scene {                           // a snapshot of REFERENCES, not copies
  id, name, color,
  drumClipId, arpClipId,          // null = silent on that engine
  bpm?, swing?, launchQuantOverride?   // optional per-scene overrides (else inherit project)
}
```

**Link vs fork.** Clips live in shared pools keyed by id; scenes *reference* them, so editing a clip
updates every scene that points at it (the Ableton mental model, minus friction). "Duplicate scene"
defaults to *link*; a one-click *fork* deep-copies the referenced clips into new ids for divergence.

---

## 6. Scenes, clips & the launcher state machine

### 6.1 Launcher state machine (per slot — scene, drum clip, or arp clip)
```
EMPTY       → click → (nothing, or "+ capture here")
STOPPED     → click → QUEUED                 (waits for the boundary)
QUEUED      → boundary → PLAYING ; click again → STOPPED (cancel queue)
PLAYING     → click → QUEUED-STOP            (pulses, stops at next boundary)
QUEUED-STOP → boundary → STOPPED
```
Driven by `scheduleLaunch(fn, quantBars)`. **Queue-next**: launching slot B while A plays queues B and
auto-stops A at the same boundary → they swap cleanly on the downbeat. One quantize engine serves both
scenes and arp clips.

### 6.2 Longer arp without fiddliness
16 bars = up to 256 steps — never shown as 256 tiny cells. Instead **bar-paginated lanes**: a
bar-strip selector (1…16) above the familiar 16-cell PULSE-style gate + velocity lanes; edit one bar at
a time. Per-bar ops: **Duplicate bar →**, **Clear bar**, **×2 length**. A zoomed-to-fit piano-roll shows
the whole clip so you keep the macro shape while editing the micro. New-bar default = repeat previous bar
→ extending stays musical with zero work.

---

## 7. UI layout

One screen, three zones, no scrolling to jam. **Reject tabs** — they'd hide the locked playhead.

```
┌─ TRANSPORT RAIL (sticky, ~64px) ─────────────────────────────────┐
│ FIRESTARTER·  [▶/■]  BPM[148]  SWING[──]  QUANT[INST·1·2·4 BAR]   │
│                      MIDI ◉ [IAC Bus ▾] [ENABLE MIDI]  [↓EXPORT▾] │
├──────────────────────── WORKBENCH ───────────────────────────────┤
│  DRUMS  (12-voice grid — full drum-machine port, always open)     │
│  ──────────────────────────────────────────────  ← SHARED ruler   │
│  ARP   (collapsible: keyboard + bar-paginated lanes + roll) [▾]   │
├──────────────────── LAUNCHER DOCK (sticky bottom, ~150px) ────────┤
│ SCENES [▣A][▣B][▣C][+]    ARP CLIPS [▶1][▶2][◷3 queued][+]  ⚡CAP │
└──────────────────────────────────────────────────────────────────┘
```
- **Unified playhead**: one `--accent-light` column with `inset 0 0 14px -3px` glow, rendered at the
  same fractional x in drums + arp via a shared step width. The centerpiece.
- **MIDI activity chip**: `◉` is `--text-dim` idle, flashes `--accent-light` ~80ms on every sent note,
  faint pulse on the bar line.
- **Signature wow — the countdown ring**: when a scene/clip is queued, an SVG `stroke-dasharray` ring
  inset on the pad drains over the bars-remaining (driven by `boundaryTick` vs `clk.tick`, NOT a timer)
  and **snaps to the lit `playing` state exactly on the downbeat**. You *see* the music arrive on the one.
- Grain overlay `fractalNoise opacity .035`, thin 8px scrollbar, `::selection` accent, all transitions
  ≤140ms ease — oxblood-cinematic, not playful.

### Pad primitive (the dock hero)
`empty` = dim border · `queued` = pulsing accent + draining ring · `playing` = solid oxblood + inset
glow · `stopping` = fading pulse + ✕ overlay. Bar-length badge on clips (e.g. `8 BARS`).

---

## 8. Jam principles ("more intuitive than Ableton")
1. **Trigger, don't configure** — every clip/scene is one click to fire; settings are secondary panels, never gates.
2. **Launch-quantize ON by default** — jamming always lands on the bar; "instant" is explicit opt-in.
3. **Always-visible transport + clock** — BPM, play, bar-count, MIDI status never scroll away.
4. **No nested menus** — flat surface; deepest interaction is a one-level right-click quick-menu.
5. **Instant audible feedback** — clicking any pad/cell auditions immediately (both engines already do this).
6. **One-button capture** — live jam → saved scene, auto-named, zero ceremony; never lose a moment.
7. **Visible state, not modes** — pad glow tells you queued/playing/stopping at a glance.

Keyboard: `1–8` scenes · `Q–I` drum clips · `A–K` arp clips · `Space` transport · `0` panic/all-stop ·
`⌘Z` undo (ring buffer, last 20 mutations). Launchpad 8×8 is *architected* (a `padMap[note]→slotRef`
table the WebMidiSink input handler will fill) but ships keyboard-first.

Autosave to `localStorage` on every mutation + manual JSON export/import.

---

## 9. File export (keep — drag .mid into Ableton)
ALL export routes through the verified `buildMidi` (embedded verbatim in core). Three exports:
- **Drum pattern** — `gatherNotes()` on channel 9.
- **Arp clip** — `resolveNotes()` on channel 1.
- **Combined / scene** — drum + arp notes merged into one multi-channel SMF (the active scene).

---

## 10. Phase-2 OSC plan
`OscSink` slots into the exact same MIDI-SINK interface, swapping a sink instance with zero engine
changes. It is a **clip-writer**, not a stream: the engine's `{pitch,start,dur,vel}` tuples buffer into
a Live clip and flush on scene-fire (`/live/clip/add/notes` then `/live/clip/fire`); transport methods
map to `/live/song/start_playing` + `/live/song/set/tempo`. Live performs the launch-quantize itself.
Requires the AbletonOSC remote-script + a small browser↔OSC bridge (WebSocket→UDP) — out of scope for v1,
fully specified by the stub's documented address mapping.

---

## 11. Pre-mortem (the single biggest risk)

**RISK — Core/UI API mismatch (build-time) compounding with audio↔MIDI timing drift (run-time).**
Two builders implement against `window.FIRESTARTER` in parallel. If the contract is even slightly
ambiguous, the UI calls methods the core didn't ship → silent no-ops, dead pads, a jam that doesn't
launch. And even with a correct API, if the WebMidiSink omits the one calibration line, the synth and
Ableton drift tens of ms apart and the whole "perfectly locked" promise collapses.

**MITIGATION (both builders MUST apply):**
1. **The API contract in §`coreApi` of the structured spec is the single source of truth.** Neither
   builder invents, renames, or "improves" a method. The core implements every listed method exactly;
   the UI calls only listed methods. Any gap is resolved by amending the spec, never by guessing.
2. **One timing path only.** Every note is scheduled against `AudioContext.currentTime` in the look-ahead
   loop, and the WebMidiSink converts with the single captured offset `performance.now() - ctx.currentTime*1000`.
   Notes are NEVER fired from `setInterval`/`setTimeout` directly. The drum and arp consumers read the same
   `clk.tick` accumulator — there is no second clock anywhere in the codebase.
3. **Fail loud, not silent.** `node --check` both JS payloads before ship. The UI surfaces sink `ready()`
   state in the MIDI chip so a dead MIDI path is visible, not mysterious. Core throws a clear console error
   if an unknown method is called in dev.
