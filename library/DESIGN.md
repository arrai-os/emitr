# EMITR LIBRARY WORLD — DESIGN.md

> The synthesis spec. One world, decisively integrated from five council lenses.
> Build target: a single self-contained `index.html` (inline CSS + JS) that loads `catalog.js`
> (`window.EMITR_CATALOG`) over `file://`. No build step, no framework, vanilla JS + Web Audio.

---

## 1. CONCEPT — THE OBSERVATORY

| | |
|---|---|
| **World name** | **EMITR · THE OBSERVATORY** |
| **Tagline** | *Your catalog as a sky you can play.* |
| **Navigation metaphor** | A dark **observatory**. The catalog is a **harmonic constellation** plotted on a slowly-breathing **Camelot wheel** — every track a star, positioned by key, sized by energy, brightness by play-readiness. The wheel IS the harmonic-mixing tool, so the metaphor and the utility are the same object. Three altitudes, always reversible: **SKY** (constellation/wheel) → **CATALOG** (data-forward card grid) → **PROFILE** (side-panel dossier), with a persistent **PIANO** ribbon docked at the bottom of every view. A `TOOLS` filter shares the same grid so Felipe's built tools live in the same sky. |
| **Tone** | Atmospheric, restrained, cinematic. Near-black + oxblood, mono type, grain. Serious-but-fun: motion and sound reward exploration, but every flourish is musically true (a star's hover-tone is its real tonic; a flickering star is a real major/minor third oscillation). "Show the sound, not the artist" — a constellation has no face, only signal. |
| **THE WOW MOMENT** | From a track profile, **PLAY THE KEY** zooms the view from the star down into the piano: the track's scale ignites across the keys note-by-note, then the **chord progression plays itself** — each chord lighting its keys in oxblood while drawing as glowing arcs on the corner Camelot wheel. For the C-Mixolydian WIP, the borrowed **A♭maj7** lights its **E♭ + A♭ keys in a colder off-scale shade** — you *see and hear the dark modal-interchange anchor flash outside the home scale*. Hearing harmony, seeing it on the keys, watching it map to the wheel — simultaneously — is when the library becomes an instrument. |

---

## 2. CATALOG STRUCTURE

`catalog.js` sets `window.EMITR_CATALOG`. Category-keyed so adding a track or tool never touches render code.

```js
window.EMITR_CATALOG = {
  meta:   { version, generatedAt, schemaVersion: 1, counts: {tracks, tools} },
  tracks: [ {trackProfile}, ... ],   // 5 real + 1 WIP at seed
  tools:  [ {toolProfile}, ... ],    // 2 real at seed (studio-composer, track-dissect)
  ideas:  []                          // reserved, empty at seed
};
```

Every entity carries the same envelope: `id`, `type` (`track|tool|idea`), `category`, `title`, `status`, `tags[]`, `comments[]`, `createdAt`, `updatedAt`. One renderer iterates `[...tracks, ...tools, ...ideas]` and filters by `type`. A new tool = push one object. Type-specific fields render via `renderProfile[type]()` switch.

A `templates` comment block at the top of `catalog.js` gives copy-paste track + tool stubs (zero-UI growth path that always works).

---

## 3. TRACK PROFILE SCHEMA (final)

Source legend: **C**=crate.json · **D**=dissect data.json · **R**=RESUME.md · **U**=user · **∂**=derived in builder.

| Field | Type | Description | Source | Editable |
|---|---|---|---|---|
| `id` | string slug | `emitr-ton-v1-3` | ∂ | no |
| `type` | `"track"` | entity discriminator | ∂ | no |
| `category` | string | `"track"` (mirror of type for grid) | ∂ | no |
| `title` | string | display name | C.title / D.track | yes |
| `version` | string | `"V1.3"` parsed from title | ∂ | yes |
| `status` | enum `idea\|wip\|mixing\|done\|released` | lifecycle | ∂ from rotation_status else U | yes |
| `key` | `{tonic,mode,label,camelot,confidence}` | `confidence={gap,second_best,top_5[]}` | C + D.features.key | tonic/mode/label yes; confidence no |
| `scale` | `{name,mode,notes[]}` | e.g. `C Mixolydian`, `["C","D","E","F","G","A","Bb"]` — the bridge field piano + scale-diagram read | R (modal) / ∂ from key | yes |
| `bpm` | number | tempo | C.bpm / D.features.tempo.bpm | yes |
| `bpmHalfTime` | number\|null | flagged if dissect noted half-time | ∂ | yes |
| `timeSignature` | string | default `"4/4"` | U | yes |
| `duration_s` | number | seconds | C.duration_s / D | no |
| `energy` | `{score,rms_mean,curve[]}` | curve = `energy_curve_1s` | C + D | no |
| `tags` | string[] | vibe tags (crate often null → U) | C.vibe_tags / U | yes |
| `files` | `{wav,midi[],stems{drums,bass,other,vocals},dissectReport,daw}` | local refs, file:// links | C path + D.stems + R.midis + U | daw=yes, rest no |
| `soundcloudUrl` | string\|null | embed reference recording | U | yes |
| `chordProgression` | `[{chord,roman?,start_s?,end_s?,borrowed?}]` | drives chord pills + piano playback; `borrowed:true` flags modal-interchange | D.chords.progression / R | yes |
| `chordSummary` | `{unique_list[],histogram[]}` | chord stats | D.chords.summary | no |
| `structure` | `[{label,start_s,end_s,rms}]` | arrangement sections | D.features.sections | no |
| `melody` | `{bass:{midi_path,pitch_range,note_count},vocals:{...}}` | monophonic MIDI refs | D.melody | no |
| `production` | `{headline,diagnosis,soundDesign[],mixMoves[],arrangement[],remakeStarter,watchOuts[]}` | from dissect synthesis brief | D.synthesis.brief | notes appendable |
| `referenceDNA` | string[] | reference artists/tracks | D.synthesis.brief.reference_dna | yes |
| `relationships` | `{harmonicMatches[],versions[]}` | Camelot ±1/relative + title-stem matches | ∂ | no |
| `comments` | `[{id,ts,author,text}]` | user notes — uuid per comment | U | yes |
| `createdAt`/`updatedAt` | ISO string | timestamps | ∂ / U-touch | no |

**Tool profile** (loose mirror): `{id, type:"tool", category, title, status:"LIVE|WIP|BACKLOG|DEFERRED", kind:"skill|dashboard", trigger, link, description, tags[], comments[], files{}, createdAt, updatedAt}` — same comment/persistence machinery, no music fields. Renders with an accent-dim left border + `⌘` glyph instead of a scale glyph.

---

## 4. PERSISTENCE — comments are never lost

Three layers, deterministic merge:

1. **Seed** = `catalog.js` (git-tracked source of truth, regenerable).
2. **Overlay** = `localStorage["emitr_observatory_overlay_v1"]` — stores **only user deltas** keyed by entity id: `{ [id]: { editableFields…, comments:[...] } }`. Never the full catalog.
3. **Merge on load** = `deepMerge(seed, overlay)` per id.
   - **Comments**: **union by `comment.id`** (uuid at creation), never overwrite — so a regenerated `catalog.js` adding new tracks AND an existing overlay both survive.
   - **Non-comment editable fields**: overlay wins (user intent > seed).
   - **Read-only fields** (duration, confidence, structure, energy): always seed.
   - **Orphan guard**: if a regenerated seed lacks an id present in overlay, the overlay entry is preserved and flagged `orphaned:true` rather than dropped.

**Round-trip:**
- **Export catalog JSON** → serializes `deepMerge(seed, overlay)` → downloads `catalog.<date>.json`. Felipe (or the builder) pastes back as next `catalog.js`/`catalog.json`.
- **Import** → validates `schemaVersion`, merges into overlay (comment-union, never destructive).
- **In-app Add Entry** → writes new entry to overlay only (file:// safety contract: app never writes disk silently).
- Every comment save fires a 300ms border-pulse confirmation — persistence is never silent.

---

## 5. COMPONENT INVENTORY (what the html-builder implements)

| Component | Spec |
|---|---|
| **Header** | Fixed, 56px. `EMITR` Bebas 28px/ls 4px left · center tabs `SKY · CATALOG · PIANO · TOOLS` (active = oxblood underline) · right `EXPORT JSON` / `IMPORT` ghost buttons + live count chip. `rgba(14,14,14,.85)` + `backdrop-filter: blur(12px)`, bottom border `#1a1a1a`. |
| **Hero (SKY landing)** | Boot sequence: grain settles → low oxblood pulse → Bebas `EMITR / THE OBSERVATORY` clamp(64–160px) with oxblood underline draw-in → constellation ignites star-by-star (~80ms stagger) with one Web Audio sub-drone tone. Status line: `5 TRACKS · 1 WIP · KEYS 3A–6A · CONSTELLATION STABLE`. |
| **Constellation / Camelot wheel** | SVG ring, 12 spokes × A/B. Each track = a dot on its Camelot slice; size=`energy_score`, brightness=`play_readiness`, slow breathe-rotation. Hover a star → plays its tonic note + pulses Camelot-compatible neighbors (±1, relative major/minor) with oxblood threads. Flicker stars (major/minor third oscillation) shift oxblood↔cooler on a slow cycle. Click a star → opens profile. Doubles as full-screen MAP harmonic-mixing surface (click two tracks → mix-compatibility + BPM delta). |
| **Track card** | `.card` `#0e0e0e`/1px `#1a1a1a`/4px/20px pad/min-h 200px. Status dot + micro-label · title Bebas 32px · chip row (KEY `A#m`, CAMELOT `3A` color-coded by wheel position, BPM `143`) · **mini scale glyph** (12-cell strip, scale degrees lit oxblood) · vibe tags + comment-count badge. Hover: border `#2a2a2a`, surface `#161616`, lift -2px, glyph cells → accent-light, 1px oxblood line wipes top. Magnetic tilt-toward-cursor parallax. |
| **Profile side-panel** | Right slide-in, 40vw / max 620px, `#0e0e0e`, 1px oxblood left edge, backdrop `rgba(6,6,6,.6)` (NOT modal — wheel + piano stay visible behind). Stacked labelled blocks: KEY/SCALE (+ full scale diagram) · TEMPO/CAMELOT/DURATION data grid · SOUNDCLOUD embed (lazy iframe) · FILES (wav/MIDI/dissect report.html as mono rows w/ 14px icon, file:// links) · CHORD PROGRESSION (clickable chord pills → piano) · PRODUCTION NOTES (synthesis brief) · REFERENCE DNA · COMMENT BOXES. |
| **Comment box** | `.card`-styled. Auto-grow textarea, mono 13px. Saved note = stacked block, timestamp `--text-dim`, 2px oxblood left-border, delete-on-hover. `ADD NOTE` ghost button. Save fires 300ms accent border-pulse. Persists to overlay keyed by id; included in Export. Keyboard map suppressed while textarea focused. |
| **Piano ribbon** | Fixed/sticky bottom ribbon, present in every view. See §6. |
| **Scale diagram** | The piano itself doubles as the per-track scale diagram (lit `.in-scale`/`.root` keys). No second widget. |
| **Chord-progression strip** | Horizontal timeline, one block per chord (label + bars). Borrowed/modal-interchange chord flagged with oxblood tick + tooltip (`♭VI borrowed from C minor`). Click block → plays just that chord on the piano. |
| **Nav / view switch** | Top tabs crossfade 220ms. Top-left always returns "up" an altitude. Filter chips in CATALOG: `All · Tracks · Tools` + key/BPM/status filters. |
| **Export / Import** | Header buttons. Export downloads merged JSON; Import validates schemaVersion + merges (comment-union). |
| **Add Entry form** | Modal → writes to overlay only. Track + tool stubs available. |
| **Grain + chrome** | Fixed full-screen SVG fractalNoise overlay opacity .035, `pointer-events:none`, `mix-blend-mode:overlay`. Custom 8px scrollbar (`#1a1a1a` thumb). `::selection {background:var(--accent);color:var(--bg)}`. All easing `cubic-bezier(.4,0,.2,1)`, no bounce. |

---

## 6. PIANO SPEC (definitive)

| | |
|---|---|
| **Range / render** | 3 octaves **C3–C6** (37 keys). HTML/CSS keys (white in flow, black absolute-positioned over gaps), each `data-midi`. Fixed/sticky bottom ribbon, reachable while scrolling profiles. Toggle `.in-scale` / `.root` / `.active` classes. |
| **Mouse** | `pointerdown`→noteOn, `pointerup`/`pointerleave`→noteOff (pointer events so drag-glissando works). |
| **Computer keyboard** | Two-row tracker map. Lower (oct 4): `A W S E D F T G Y H U J K` = C C# D D# E F F# G G# A A# B C. Upper (oct 5): `K O L P ; '` = C C# D D# E F. `Z`/`X` shift active octave. `keydown` guarded vs auto-repeat via held-set. Suppressed when a comment textarea has focus. |
| **Synth signal chain** | Per note: 2× sawtooth osc (osc2 detune +7c) → gain ADSR (A 8ms · D 120ms · S 0.6 · R 350ms) → lowpass biquad ~1800Hz Q 0.7 → master gain → destination, with a shared feedback-delay send (0.32s, fb 0.28) for pseudo-reverb. Dark/atmospheric, techno not chiptune. One `AudioContext`, lazily `resume()`d on first gesture. |
| **Polyphony** | Voice objects keyed by MIDI number, capped ~12, oldest-stolen. Chord playback uses same pool. |
| **Scale highlight** | On track-select, read `scale.notes` (or tonic+mode → SCALES interval table: Ionian/Dorian/Phrygian/Lydian/**Mixolydian [0,2,4,5,7,9,10]**/Aeolian/Locrian). Keys where `(midi-root)%12 ∈ set` → `.in-scale` (accent-dim wash); root → `.root` (accent-light + octave underline); out-of-scale → dim `--text-dim`. |
| **Play Progression** | Chord parser: root+accidental → pitch class, quality suffix table (`m/min`, `maj7`, `7`, `add9`, `9`, `dim`, `sus4`…). `Cadd9→B♭→A♭maj7→Fmaj7` → `[C,E,G,D][B♭,D,F][A♭,C,E♭,G][F,A,C,E]`. `▶ Play Progression` schedules each chord (2 bars at track BPM from crate), lights keys live. A♭maj7 deliberately flashes its off-scale **E♭/A♭** keys in `--accent-light` — the RESUME.md lead-writing caution made visible+audible. |
| **Explore mode** | No track selected: root dropdown + scale dropdown drive the same highlight engine → standalone scale toy. |
| **SoundCloud coexistence** | SC embed = the reference recording (listen); piano = the instrument (play). Starting Play Progression mutes the SC iframe via Widget API so you never hear both. |

---

## 7. VISUALIZATIONS

| Viz | Tier | Description |
|---|---|---|
| **Camelot / harmonic constellation wheel** | core | The landing + the working harmonic-mixing map. Tracks plotted by Camelot; select highlights harmonic neighbors. Click slice → filter catalog. |
| **Scale diagram (= the piano)** | core | Per-track scale lit on the keyboard. No second widget. |
| **Chord-progression strip** | core | Timeline blocks per chord; borrowed chord flagged + tooltip; click → play that chord. |
| **Mini wheel-in-corner during playback** | core | While Play Progression runs, each chord draws as a glowing arc on a corner Camelot wheel (the wow moment's map layer). |
| **Audio-reactive waveform** | nice-to-have | `AnalyserNode` on master drives a thin oxblood waveform line behind the piano while it sounds. Cheap, never load-bearing. |
| **Energy curve sparkline** | nice-to-have | `energy_curve_1s` as a small sparkline in the profile structure block. |
| **Force-directed relationship graph** | nice-to-have (→ phase 2) | Harmonic + version + shared-tag edges. v1 ships derived relationships as a simple "versions" + "mixes with" strip; full graph deferred. |

---

## 8. PHASE 2 — DEFERRED (record, don't build)

1. **Live data-builder regen** — script re-reads crates + dissects + WIP RESUME.md → regenerates `catalog.js` so dropping a WAV auto-appears (closes the manual-edit loop).
2. **Force-directed relationship graph view** — visual set-building map of harmonic/version/tag edges.
3. **Tool launch-from-card** — wire `/`-triggers to the capture-bot exec registry so a tool entry's "launch" button fires the skill and links back its `exec/<ts>-skill.html` output.
4. **Shareable deploy** — private GitHub Pages (phone-accessible), only once Felipe wants it outward. v1 stays local file://.
5. **ConvolverReverb upgrade** — true impulse-response reverb replacing the feedback-delay send.

---

## 9. PRE-MORTEM

| Risk | Mitigation |
|---|---|
| **The build is gorgeous but musically wrong — the piano plays out-of-tune/wrong notes, the scale highlight is off, or `file://` blocks the data and the page is empty.** This is the single failure that turns an instrument back into a dead spreadsheet. | (1) **Never `fetch()` local JSON** — data loads ONLY via `<script src="catalog.js">` → `window.EMITR_CATALOG` (works on file://); the builder must verify the page renders by double-click, not a localhost server. (2) **Equal-temperament tuning is exact**: `freq = 440 * 2**((midi-69)/12)`, root pitch-class from a single canonical note table (C=0…B=11), Ableton numbering noted (C1=MIDI 36) but synth uses standard MIDI. (3) **Scale + chord engines tested against the WIP ground truth**: C Mixolydian = `[0,2,4,5,7,9,10]` from C must light exactly C D E F G A B♭ and dim B♮; `Cadd9→B♭→A♭maj7→Fmaj7` must voice `[C E G D][B♭ D F][A♭ C E♭ G][F A C E]` with A♭maj7's E♭/A♭ rendering off-scale. If those two assertions pass, the harmony layer is trustworthy. (4) **AudioContext lazily resumed on first user gesture** (autoplay policy) or the piano is silent on load. |

---

*Source files (quote the trailing space in `AE_Claude `):*
- `…/tracks/*.wav.crate.json` · `…/tracks/dissect/<slug>/data.json` + `report.html` · `…/tracks/wip/2026-06-cmixo-nostalgic/RESUME.md`
- Output: `…/projects/emitr-reactivation/library/{DESIGN.md, catalog.json, catalog.js, index.html}`
