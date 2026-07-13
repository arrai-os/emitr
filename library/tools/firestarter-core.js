/* ==========================================================================
   EMITR · FIRESTARTER — firestarter-core.js
   The HEADLESS engine. One 96-PPQN look-ahead master clock drives BOTH the
   drum sequencer AND the arp. The engine talks ONLY to an abstract MIDI-SINK.

   "One clock. Two engines. Infinite firestarters."

   HARD RULES honoured by this file:
   1. ONE timing path. Every note is scheduled against AudioContext.currentTime
      inside the look-ahead loop. Drums and arp read the SAME tick accumulator
      (clk.tick) so they are provably unable to drift apart. NEVER does a
      setInterval/setTimeout fire a note directly — the timer only WAKES the
      scheduler, which then schedules sample-accurate audio + sink events.
   2. The engine only ever talks to a MIDI-SINK ({sendNoteOn, sendNoteOff,
      sendCC, sendClock, sendStart, sendStop, sendContinue, ready}). WebMidiSink
      ships now (realtime note stream). OscSink is a documented phase-2 stub.
   3. Node-require-safe. ALL Web Audio / Web MIDI / DOM / localStorage access is
      feature-detected and lazy. require()-ing this file in Node never throws,
      so the data + scheduler logic is unit-testable.

   Exposes window.FIRESTARTER (browser) and module.exports (Node).
   ========================================================================== */
(function (global) {
'use strict';

/* ==========================================================================
   ENVIRONMENT GUARDS — feature detection, never throw at load time
   ========================================================================== */
var HAS_WINDOW   = typeof window !== 'undefined';
var HAS_DOCUMENT = typeof document !== 'undefined';
var AudioCtor = (HAS_WINDOW && (window.AudioContext || window.webkitAudioContext)) || null;
function hasLocalStorage() {
  try { return typeof localStorage !== 'undefined' && localStorage !== null; }
  catch (e) { return false; }
}
function hasMidiAccess() {
  return typeof navigator !== 'undefined' && navigator &&
         typeof navigator.requestMIDIAccess === 'function';
}
function nowMs() {
  if (typeof performance !== 'undefined' && performance && performance.now) return performance.now();
  return Date.now();
}

/* ==========================================================================
   MIDI ENCODER — embedded VERBATIM (verified SMF, read by pretty_midi/Ableton)
   notes: [{pitch:0-127, start:beats, duration:beats, velocity:1-127, channel:0-15}]
   ========================================================================== */
function buildMidi(notes, opts) {
  opts = opts || {};
  const ppq = opts.ppq || 480;
  const bpm = opts.bpm || 120;
  const trackName = opts.trackName || 'EMITR';
  function vlq(value) {
    const bytes = [];
    let buffer = value & 0x7f;
    while ((value >>= 7) > 0) { buffer <<= 8; buffer |= ((value & 0x7f) | 0x80); }
    while (true) { bytes.push(buffer & 0xff); if (buffer & 0x80) buffer >>= 8; else break; }
    return bytes;
  }
  const push32 = (a, v) => a.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const push16 = (a, v) => a.push((v >>> 8) & 0xff, v & 0xff);
  const str = (a, s) => { for (let i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 0xff); };
  const events = [];
  const usPerQuarter = Math.round(60000000 / bpm);
  events.push({ tick: 0, order: 0, data: [0xFF, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] });
  const nameBytes = []; str(nameBytes, trackName);
  events.push({ tick: 0, order: 0, data: [0xFF, 0x03, ...vlq(nameBytes.length), ...nameBytes] });
  for (const n of notes) {
    const ch = (n.channel || 0) & 0x0f;
    const pitch = Math.max(0, Math.min(127, n.pitch | 0));
    const vel = Math.max(1, Math.min(127, (n.velocity || 100) | 0));
    const startTick = Math.round((n.start || 0) * ppq);
    const endTick = Math.round(((n.start || 0) + (n.duration || 0.25)) * ppq);
    events.push({ tick: startTick, order: 1, data: [0x90 | ch, pitch, vel] });
    events.push({ tick: Math.max(endTick, startTick + 1), order: 0, data: [0x80 | ch, pitch, 0] });
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const trk = [];
  let last = 0;
  for (const e of events) { trk.push(...vlq(e.tick - last), ...e.data); last = e.tick; }
  trk.push(0x00, 0xFF, 0x2F, 0x00);
  const out = [];
  str(out, 'MThd'); push32(out, 6); push16(out, 0); push16(out, 1); push16(out, ppq);
  str(out, 'MTrk'); push32(out, trk.length); for (const b of trk) out.push(b);
  return new Uint8Array(out);
}

/* ==========================================================================
   CONSTANTS — clock + drum + arp domain knowledge (ported)
   ========================================================================== */
var PPQN = 96;                 // internal master resolution (24*16th, etc.)
var TICKS_PER_16TH = PPQN / 4; // = 24
var TICKS_PER_BAR  = PPQN * 4; // = 384 (4/4)
var MIDI_PULSE_PER_TICK = 4;   // 96 PPQN / 24 PPQN MIDI clock = pulse when tick%4===0
var LOOKAHEAD_MS = 25;         // setTimeout cadence — wakes scheduler, never fires notes
var SCHEDULE_AHEAD = 0.10;     // seconds: how far ahead we commit audio/sink events
var START_LATENCY = 0.06;      // seconds: gap before first tick on start()

/* ---- DRUM VOICES — General MIDI drum map (ported verbatim from drum-machine) */
var VOICES = [
  { id: 'kick',    name: 'Kick',       note: 36, synth: 'kick',   dur: 0.12 },
  { id: 'snare',   name: 'Snare',      note: 38, synth: 'snare',  dur: 0.12 },
  { id: 'clap',    name: 'Clap',       note: 39, synth: 'clap',   dur: 0.12 },
  { id: 'chat',    name: 'Closed Hat', note: 42, synth: 'chat',   dur: 0.05 },
  { id: 'ohat',    name: 'Open Hat',   note: 46, synth: 'ohat',   dur: 0.25 },
  { id: 'ltom',    name: 'Low Tom',    note: 45, synth: 'ltom',   dur: 0.18 },
  { id: 'htom',    name: 'Hi Tom',     note: 50, synth: 'htom',   dur: 0.18 },
  { id: 'rim',     name: 'Rimshot',    note: 37, synth: 'rim',    dur: 0.05 },
  { id: 'ride',    name: 'Ride',       note: 51, synth: 'ride',   dur: 0.25 },
  { id: 'crash',   name: 'Crash',      note: 49, synth: 'crash',  dur: 0.40 },
  { id: 'shaker',  name: 'Shaker',     note: 70, synth: 'shaker', dur: 0.05 },
  { id: 'cowbell', name: 'Cowbell',    note: 56, synth: 'cowbell',dur: 0.12 }
];
var LEVEL_VEL = { 1: 100, 2: 127, 3: 55 }; // 0=off, 1=normal, 2=accent, 3=ghost

/* ---- ARP THEORY (ported verbatim from arpeggiator) */
var NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
var CHORD_TYPES = {
  'maj':   {label:'maj',   ivals:[0,4,7]},
  'min':   {label:'min',   ivals:[0,3,7]},
  'maj7':  {label:'maj7',  ivals:[0,4,7,11]},
  'm7':    {label:'m7',    ivals:[0,3,7,10]},
  '7':     {label:'7 (dom7)', ivals:[0,4,7,10]},
  'sus2':  {label:'sus2',  ivals:[0,2,7]},
  'sus4':  {label:'sus4',  ivals:[0,5,7]},
  'dim':   {label:'dim',   ivals:[0,3,6]},
  'aug':   {label:'aug',   ivals:[0,4,8]},
  '6':     {label:'6',     ivals:[0,4,7,9]},
  'm6':    {label:'m6',    ivals:[0,3,7,9]},
  'add9':  {label:'add9',  ivals:[0,4,7,14]},
  'm9':    {label:'m9',    ivals:[0,3,7,10,14]},
  'maj9':  {label:'maj9',  ivals:[0,4,7,11,14]},
  '9':     {label:'9',     ivals:[0,4,7,10,14]}
};
var ROOT_OCTAVE_MIDI = 60; // C4

function midiName(m) {
  var name = NOTE_NAMES[((m % 12) + 12) % 12];
  var oct = Math.floor(m / 12) - 1;
  return { name: name, oct: oct, full: name + oct };
}

/* ==========================================================================
   UTILITIES
   ========================================================================== */
var _idCounter = 0;
function uid(prefix) {
  _idCounter++;
  return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + _idCounter.toString(36);
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

/* ==========================================================================
   EVENT BUS — UI subscribes (onStep, onTick, onLaunch, onSceneChange, ...)
   ========================================================================== */
var listeners = {}; // eventName -> [cb]
function on(evt, cb) {
  if (!listeners[evt]) listeners[evt] = [];
  listeners[evt].push(cb);
  return cb;
}
function off(evt, cb) {
  if (!listeners[evt]) return;
  var i = listeners[evt].indexOf(cb);
  if (i >= 0) listeners[evt].splice(i, 1);
}
function emit(evt, a, b) {
  var arr = listeners[evt];
  if (!arr) return;
  // iterate over a copy so a handler can unsubscribe safely
  var copy = arr.slice();
  for (var i = 0; i < copy.length; i++) {
    try { copy[i](a, b); } catch (e) { if (HAS_WINDOW && global.console) console.error('[FIRESTARTER] listener error on ' + evt, e); }
  }
}

/* ==========================================================================
   PROJECT STATE — single source of truth, persisted to localStorage
   ========================================================================== */
var LS_KEY = 'firestarter-v1';

function defaultDrumClip(name, lengthBars) {
  lengthBars = lengthBars || 1;
  var steps = 16 * lengthBars;
  var pattern = {};
  var mute = {}, solo = {}, human = {};
  VOICES.forEach(function (v) {
    pattern[v.id] = new Array(steps).fill(0);
    mute[v.id] = false; solo[v.id] = false; human[v.id] = false;
  });
  return {
    id: uid('drum'),
    name: name || 'Drums',
    lengthBars: lengthBars,
    steps: steps,
    pattern: pattern,
    mute: mute,
    solo: solo,
    human: human
  };
}

function defaultArpClip(name, lengthBars) {
  lengthBars = lengthBars || 1;
  var steps = computeArpSteps(lengthBars, '1/16'); // sensible default
  return {
    id: uid('arp'),
    name: name || 'Arp',
    lengthBars: lengthBars,
    root: 0,
    type: 'min',
    octaves: 1,
    mode: 'up',
    rate: '1/16',
    gate: 80,
    cutoff: 2200,
    hold: false,
    customNotes: [],
    steps: steps,
    pattern: new Array(steps).fill(true),
    velocities: new Array(steps).fill(100),
    channel: 0,
    seed: 1,            // deterministic seed for math styles
    styleParams: {}     // { <styleKey>: { <paramName>: value } } persisted per math style
  };
}

/* steps that fit in N bars at a given rate (so an arp clip loops cleanly per bar) */
function computeArpSteps(lengthBars, rate) {
  var sl = stepLengthBeatsFor(rate);          // beats per arp step
  var perBar = Math.max(1, Math.round(4 / sl)); // 4 beats per bar
  return perBar * lengthBars;
}

function defaultProject() {
  var d = defaultDrumClip('Drums', 1);
  var a = defaultArpClip('Arp', 1);
  var drumClips = {}; drumClips[d.id] = d;
  var arpClips = {}; arpClips[a.id] = a;
  return {
    v: 1,
    bpm: 148,
    swing: 0,
    launchQuant: 'instant',
    lengthBars: 4,
    midi: { outId: null, drumCh: 9, arpCh: 0, clockEnabled: true, asMaster: true },
    drumClips: drumClips,
    arpClips: arpClips,
    scenes: [],
    activeSceneId: null,
    queuedSceneId: null,
    liveDrumClipId: d.id,
    liveArpClipId: a.id
  };
}

var project = defaultProject();

/* ---- persistence (guarded) ---- */
function persistSave() {
  if (!hasLocalStorage()) return;
  try { localStorage.setItem(LS_KEY, JSON.stringify(project)); } catch (e) {}
}
function persistLoad() {
  if (!hasLocalStorage()) return false;
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    var obj = JSON.parse(raw);
    if (obj && obj.v) { migrateProject(obj); project = obj; return true; }
  } catch (e) {}
  return false;
}
/* ensure loaded projects have every required field / voice (forward-compat) */
function migrateProject(p) {
  if (!p.midi) p.midi = { outId: null, drumCh: 9, arpCh: 0, clockEnabled: true, asMaster: true };
  if (p.midi.drumCh == null) p.midi.drumCh = 9;
  if (p.midi.arpCh == null) p.midi.arpCh = 0;
  if (p.midi.clockEnabled == null) p.midi.clockEnabled = true;
  if (!p.drumClips) p.drumClips = {};
  if (!p.arpClips) p.arpClips = {};
  if (!p.scenes) p.scenes = [];
  if (p.swing == null) p.swing = 0;
  if (!p.launchQuant) p.launchQuant = 'instant';
  if (!p.bpm) p.bpm = 148;
  // ensure each drum clip has all voices
  Object.keys(p.drumClips).forEach(function (id) {
    var dc = p.drumClips[id];
    if (!dc.pattern) dc.pattern = {};
    if (!dc.mute) dc.mute = {}; if (!dc.solo) dc.solo = {}; if (!dc.human) dc.human = {};
    var steps = dc.steps || (16 * (dc.lengthBars || 1));
    dc.steps = steps;
    VOICES.forEach(function (v) {
      if (!Array.isArray(dc.pattern[v.id])) dc.pattern[v.id] = new Array(steps).fill(0);
      if (dc.mute[v.id] == null) dc.mute[v.id] = false;
      if (dc.solo[v.id] == null) dc.solo[v.id] = false;
      if (dc.human[v.id] == null) dc.human[v.id] = false;
    });
  });
  // ensure live ids point somewhere valid
  var dkeys = Object.keys(p.drumClips), akeys = Object.keys(p.arpClips);
  if (!p.drumClips[p.liveDrumClipId]) p.liveDrumClipId = dkeys[0] || null;
  if (!p.arpClips[p.liveArpClipId]) p.liveArpClipId = akeys[0] || null;
  // guarantee at least one of each so the live engine always has content
  if (!p.liveDrumClipId) { var d = defaultDrumClip('Drums', 1); p.drumClips[d.id] = d; p.liveDrumClipId = d.id; }
  if (!p.liveArpClipId) { var a = defaultArpClip('Arp', 1); p.arpClips[a.id] = a; p.liveArpClipId = a.id; }
}

function liveDrum() { return project.drumClips[project.liveDrumClipId] || null; }
function liveArp()  { return project.arpClips[project.liveArpClipId] || null; }

/* mutation helper: persist + emit a state change so the UI re-renders */
function touch(evt, payload) {
  persistSave();
  if (evt) emit(evt, payload);
  emit('onChange', { evt: evt, payload: payload });
}

/* ==========================================================================
   ARP MUSIC MATH — ported verbatim, parameterised by a clip
   ========================================================================== */
function getChordBasePitches(clip) {
  if (clip.customNotes && clip.customNotes.length) {
    return clip.customNotes.slice().sort(function (a, b) { return a - b; });
  }
  var ct = CHORD_TYPES[clip.type] || CHORD_TYPES.min;
  var rootMidi = ROOT_OCTAVE_MIDI + clip.root;
  return ct.ivals.map(function (iv) { return rootMidi + iv; });
}
function getStackedPitches(clip) {
  var base = getChordBasePitches(clip);
  var out = [];
  for (var o = 0; o < clip.octaves; o++) {
    for (var i = 0; i < base.length; i++) out.push(base[i] + o * 12);
  }
  return out;
}
function buildArpCycle(clip, pitches) {
  var sorted = pitches.slice().sort(function (a, b) { return a - b; });
  switch (clip.mode) {
    case 'up':   return sorted.slice();
    case 'down': return sorted.slice().reverse();
    case 'updown': {
      if (sorted.length <= 1) return sorted.slice();
      var up = sorted.slice();
      var down = sorted.slice(1, -1).reverse();
      return up.concat(down);
    }
    case 'downup': {
      if (sorted.length <= 1) return sorted.slice();
      var d = sorted.slice().reverse();
      var u = sorted.slice(1, -1);
      return d.concat(u);
    }
    case 'converge': {
      var res = []; var lo = 0, hi = sorted.length - 1;
      while (lo <= hi) { res.push(sorted[lo]); if (lo !== hi) res.push(sorted[hi]); lo++; hi--; }
      return res;
    }
    case 'diverge': {
      var r2 = []; var n = sorted.length;
      var mid = Math.floor((n - 1) / 2);
      var l, rr;
      if (n % 2 === 1) { r2.push(sorted[mid]); l = mid - 1; rr = mid + 1; }
      else { l = mid; rr = mid + 1; }
      while (l >= 0 || rr < n) {
        if (l >= 0) { r2.push(sorted[l]); l--; }
        if (rr < n) { r2.push(sorted[rr]); rr++; }
      }
      return r2;
    }
    case 'asplayed': return pitches.slice();
    case 'random': {
      var arr = sorted.slice();
      for (var i = arr.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      }
      return arr;
    }
    case 'chord': return [sorted.slice()]; // array-of-array marker
    default: return sorted.slice();
  }
}
function stepLengthBeatsFor(rate) {
  switch (rate) {
    case '1/4':   return 1;
    case '1/4.':  return 1 * 1.5;
    case '1/8':   return 0.5;
    case '1/8.':  return 0.5 * 1.5;
    case '1/8T':  return 0.5 * (2 / 3);
    case '1/16':  return 0.25;
    case '1/16.': return 0.25 * 1.5;
    case '1/16T': return 0.25 * (2 / 3);
    case '1/32':  return 0.125;
    default:      return 0.25;
  }
}
function stepLengthBeats(clip) { return stepLengthBeatsFor(clip.rate); }

/* ==========================================================================
   MATH STYLES (window.ARP_STYLES) — routed sibling branch.
   A clip.mode that is a key in window.ARP_STYLES uses the verified generator.
   Adapter returns a DIRECT length-N program (idx = stepIndex maps 1:1).
   ========================================================================== */
function _ARP_STYLES() { return (typeof window !== 'undefined' && window.ARP_STYLES) ? window.ARP_STYLES : null; }
function isMathMode(mode) { var S = _ARP_STYLES(); return !!(S && S[mode]); }
function styleParamsFor(clip) {
  var S = _ARP_STYLES();
  var st = S && S[clip.mode];
  if (!st) return {};
  clip.styleParams = clip.styleParams || {};
  var saved = clip.styleParams[clip.mode] || {};
  var out = {};
  for (var i = 0; i < st.params.length; i++) {
    var p = st.params[i];
    out[p.name] = (saved[p.name] !== undefined) ? saved[p.name] : p.default;
  }
  return out;
}
function _pmod(a, m) { return ((a % m) + m) % m; }
/* Build the math program for a clip. Returns { pitches:[int|null], velocities:[int], rests:[bool] } length steps. */
function buildMathProgram(clip) {
  var S = _ARP_STYLES();
  var st = S[clip.mode];
  // pool = resolved chord tones for the BASE octave span (style drives octShift).
  var pool = getChordBasePitches(clip).slice().sort(function (a, b) { return a - b; });
  var L = pool.length || 1;
  var opts = { length: clip.steps, seed: (clip.seed | 0) || 1, octaves: Math.max(1, clip.octaves | 0) };
  var sp = styleParamsFor(clip);
  for (var key in sp) { if (Object.prototype.hasOwnProperty.call(sp, key)) opts[key] = sp[key]; }
  var program = st.gen(pool, opts);
  var pitches = [], velocities = [], rests = [];
  for (var i = 0; i < program.length; i++) {
    var s = program[i];
    if (s.idx === null) { pitches.push(null); velocities.push(0); rests.push(true); }
    else {
      pitches.push(pool[_pmod(s.idx, L)] + 12 * s.octShift);
      velocities.push(s.vel);
      rests.push(false);
    }
  }
  return { pitches: pitches, velocities: velocities, rests: rests };
}
/* signature for the live program cache (extends the cycle cache contract) */
function mathProgramSig(clip) {
  return clip.mode + '|' + clip.root + '|' + clip.type + '|' + clip.octaves + '|' +
         clip.steps + '|' + ((clip.seed | 0) || 1) + '|' +
         (clip.customNotes || []).join(',') + '|' +
         JSON.stringify((clip.styleParams && clip.styleParams[clip.mode]) || {});
}

/* resolve one arp clip to note tuples {pitch,start,duration,velocity,channel}.
   start/duration are in BEATS (quarter=1). Swing applied so it matches playback. */
function resolveArpNotes(clip, swing, channelOverride) {
  var N = clip.steps;
  var sl = stepLengthBeats(clip);
  var gate = clip.gate / 100;
  var swingAmt = (swing || 0) / 100;
  var ch = (channelOverride != null) ? channelOverride : (clip.channel != null ? clip.channel : 0);
  var notes = [];

  // ---- MATH STYLE BRANCH ----
  if (isMathMode(clip.mode)) {
    var prog = buildMathProgram(clip);
    for (var mi = 0; mi < N; mi++) {
      var mp = prog.pitches[mi];
      var mrest = prog.rests[mi];
      var manualOn = clip.pattern[mi] !== false;
      if (!manualOn || mrest || mp == null) continue;
      var mSwing = (mi % 2 === 1) ? swingAmt * sl : 0;
      var mStart = mi * sl + mSwing;
      var mDur = Math.max(0.001, gate * sl);
      var styleVel = prog.velocities[mi] != null ? prog.velocities[mi] : 100;
      var manualVel = clip.velocities[mi] != null ? clip.velocities[mi] : 100;
      var mVel = Math.max(1, Math.min(127, Math.round(styleVel * (manualVel / 100))));
      notes.push({ pitch: mp, start: mStart, duration: mDur, velocity: mVel, channel: ch });
    }
    return notes;
  }

  // ---- EXISTING (built-in) MODES — unchanged ----
  var stacked = getStackedPitches(clip);
  var cycle = buildArpCycle(clip, stacked);
  var chordMode = clip.mode === 'chord';
  for (var i = 0; i < N; i++) {
    var pitches;
    if (chordMode) {
      pitches = cycle[0] ? cycle[0].slice() : [];
    } else {
      var idx = cycle.length ? (i % cycle.length) : 0;
      var p = cycle.length ? cycle[idx] : null;
      pitches = (p === null || p === undefined) ? [] : [p];
    }
    var on = clip.pattern[i] !== false;
    if (!on) continue;
    var swingOffset = (i % 2 === 1) ? swingAmt * sl : 0;
    var start = i * sl + swingOffset;
    var duration = Math.max(0.001, gate * sl);
    var vel = clip.velocities[i] != null ? clip.velocities[i] : 100;
    for (var k = 0; k < pitches.length; k++) {
      if (pitches[k] == null) continue;
      notes.push({ pitch: pitches[k], start: start, duration: duration, velocity: vel, channel: ch });
    }
  }
  return notes;
}

/* number of arp steps per master-tick (for the clock's onStep derivation) */
function ticksPerArpStep(clip) {
  return Math.max(1, Math.round(PPQN * stepLengthBeats(clip)));
}

/* ==========================================================================
   DRUM MATH — gatherNotes ported verbatim (channel 9, beats domain)
   ========================================================================== */
function anySolo(dc) { return VOICES.some(function (v) { return dc.solo[v.id]; }); }
function isAudible(dc, voiceId) {
  if (dc.mute[voiceId]) return false;
  if (anySolo(dc)) return dc.solo[voiceId];
  return true;
}
function swingOffsetBeats(stepIndex, swing) {
  if (!swing || swing <= 0) return 0;
  if (stepIndex % 2 === 1) return 0.25 * (swing / 100) * 0.5;
  return 0;
}
function gatherDrumNotes(dc, swing, channelOverride) {
  var ch = (channelOverride != null) ? channelOverride : 9;
  var notes = [];
  VOICES.forEach(function (v) {
    var row = dc.pattern[v.id];
    for (var i = 0; i < dc.steps; i++) {
      var lvl = row[i];
      if (!lvl) continue;
      if (!isAudible(dc, v.id)) continue;
      var vel = LEVEL_VEL[lvl];
      var start = i * 0.25 + swingOffsetBeats(i, swing);
      notes.push({ pitch: v.note, start: start, duration: v.dur, velocity: vel, channel: ch });
    }
  });
  return notes;
}

/* ==========================================================================
   WEB AUDIO SYNTH — lazy, guarded. Drums (drum-machine voices) + arp (saw synth)
   ========================================================================== */
var audioCtx = null;
var noiseBuffer = null;
var arpMaster = null, arpDelay = null, arpDelayFb = null, arpDelayWet = null, arpDelaySend = null;

function ensureAudio() {
  if (audioCtx) { if (audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch (e) {} } return audioCtx; }
  if (!AudioCtor) return null; // headless/Node — no audio, engine still works for data + export
  audioCtx = new AudioCtor();
  // white-noise buffer for hats/snare/clap
  var len = Math.floor(audioCtx.sampleRate * 1.0);
  noiseBuffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  var data = noiseBuffer.getChannelData(0);
  for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  // arp synth bus (master + feedback delay), ported from arpeggiator
  arpMaster = audioCtx.createGain(); arpMaster.gain.value = 0.5; arpMaster.connect(audioCtx.destination);
  arpDelayWet = audioCtx.createGain(); arpDelayWet.gain.value = 0.28;
  arpDelay = audioCtx.createDelay(2.0); arpDelay.delayTime.value = 0.0;
  arpDelayFb = audioCtx.createGain(); arpDelayFb.gain.value = 0.34;
  arpDelay.connect(arpDelayFb); arpDelayFb.connect(arpDelay);
  arpDelay.connect(arpDelayWet); arpDelayWet.connect(arpMaster);
  arpDelaySend = audioCtx.createGain(); arpDelaySend.gain.value = 1.0;
  arpDelaySend.connect(arpDelay);
  return audioCtx;
}
function audioTime() { return audioCtx ? audioCtx.currentTime : (nowMs() / 1000); }
function noiseSource() { var s = audioCtx.createBufferSource(); s.buffer = noiseBuffer; return s; }

/* ---- drum synth voices (ported verbatim from drum-machine) ---- */
var DRUM_SYNTH = {
  kick: function (t, g) {
    var o = audioCtx.createOscillator(), gn = audioCtx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 0.12);
    gn.gain.setValueAtTime(g, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(gn).connect(audioCtx.destination); o.start(t); o.stop(t + 0.42);
    var c = noiseSource(), cg = audioCtx.createGain(), cf = audioCtx.createBiquadFilter();
    cf.type = 'highpass'; cf.frequency.value = 1200;
    cg.gain.setValueAtTime(g * 0.7, t); cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
    c.connect(cf).connect(cg).connect(audioCtx.destination); c.start(t); c.stop(t + 0.03);
  },
  snare: function (t, g) {
    var n = noiseSource(), nf = audioCtx.createBiquadFilter(), ng = audioCtx.createGain();
    nf.type = 'highpass'; nf.frequency.value = 1000;
    ng.gain.setValueAtTime(g * 0.9, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    n.connect(nf).connect(ng).connect(audioCtx.destination); n.start(t); n.stop(t + 0.2);
    var o = audioCtx.createOscillator(), og = audioCtx.createGain();
    o.type = 'triangle'; o.frequency.value = 180;
    og.gain.setValueAtTime(g * 0.5, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(og).connect(audioCtx.destination); o.start(t); o.stop(t + 0.12);
  },
  chat: function (t, g) {
    var n = noiseSource(), nf = audioCtx.createBiquadFilter(), ng = audioCtx.createGain();
    nf.type = 'highpass'; nf.frequency.value = 7000;
    ng.gain.setValueAtTime(g * 0.5, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    n.connect(nf).connect(ng).connect(audioCtx.destination); n.start(t); n.stop(t + 0.05);
  },
  ohat: function (t, g) {
    var n = noiseSource(), nf = audioCtx.createBiquadFilter(), ng = audioCtx.createGain();
    nf.type = 'highpass'; nf.frequency.value = 6000;
    ng.gain.setValueAtTime(g * 0.45, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    n.connect(nf).connect(ng).connect(audioCtx.destination); n.start(t); n.stop(t + 0.32);
  },
  clap: function (t, g) {
    [0, 0.012, 0.024].forEach(function (off, i) {
      var n = noiseSource(), nf = audioCtx.createBiquadFilter(), ng = audioCtx.createGain();
      nf.type = 'bandpass'; nf.frequency.value = 1500; nf.Q.value = 1.2;
      var amp = g * (i === 2 ? 0.9 : 0.6);
      ng.gain.setValueAtTime(amp, t + off);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + off + (i === 2 ? 0.14 : 0.04));
      n.connect(nf).connect(ng).connect(audioCtx.destination); n.start(t + off); n.stop(t + off + 0.16);
    });
  },
  tom: function (t, g, freq, dur) {
    var o = audioCtx.createOscillator(), gn = audioCtx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.55, t + dur);
    gn.gain.setValueAtTime(g, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
    o.connect(gn).connect(audioCtx.destination); o.start(t); o.stop(t + dur + 0.07);
  },
  ltom: function (t, g) { DRUM_SYNTH.tom(t, g, 110, 0.3); },
  htom: function (t, g) { DRUM_SYNTH.tom(t, g, 200, 0.25); },
  rim: function (t, g) {
    var o = audioCtx.createOscillator(), gn = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = 1700;
    gn.gain.setValueAtTime(g * 0.5, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    o.connect(gn).connect(audioCtx.destination); o.start(t); o.stop(t + 0.04);
  },
  ride: function (t, g) {
    var n = noiseSource(), nf = audioCtx.createBiquadFilter(), ng = audioCtx.createGain();
    nf.type = 'bandpass'; nf.frequency.value = 5500; nf.Q.value = 2;
    ng.gain.setValueAtTime(g * 0.35, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    n.connect(nf).connect(ng).connect(audioCtx.destination); n.start(t); n.stop(t + 0.52);
  },
  crash: function (t, g) {
    var n = noiseSource(), nf = audioCtx.createBiquadFilter(), ng = audioCtx.createGain();
    nf.type = 'bandpass'; nf.frequency.value = 4000; nf.Q.value = 0.7;
    ng.gain.setValueAtTime(g * 0.4, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
    n.connect(nf).connect(ng).connect(audioCtx.destination); n.start(t); n.stop(t + 1.05);
  },
  shaker: function (t, g) {
    var n = noiseSource(), nf = audioCtx.createBiquadFilter(), ng = audioCtx.createGain();
    nf.type = 'highpass'; nf.frequency.value = 8000;
    ng.gain.setValueAtTime(0.0001, t); ng.gain.linearRampToValueAtTime(g * 0.4, t + 0.01);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    n.connect(nf).connect(ng).connect(audioCtx.destination); n.start(t); n.stop(t + 0.07);
  },
  cowbell: function (t, g) {
    [540, 800].forEach(function (freq) {
      var o = audioCtx.createOscillator(), gn = audioCtx.createGain();
      o.type = 'square'; o.frequency.value = freq;
      gn.gain.setValueAtTime(g * 0.3, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(gn).connect(audioCtx.destination); o.start(t); o.stop(t + 0.22);
    });
  }
};
function synthDrum(voice, when, velocity) {
  if (!ensureAudio()) return;
  var g = Math.max(0.05, Math.min(1, velocity / 127));
  var fn = DRUM_SYNTH[voice.synth];
  if (fn) fn(when, g);
}

/* ---- arp synth voice (ported verbatim from arpeggiator) ---- */
function synthArp(pitches, velocity, when, durSec, cutoff) {
  if (!ensureAudio()) return;
  var vGain = audioCtx.createGain();
  var peak = 0.16 * (velocity / 127);
  var a = 0.006, d = 0.09, s = 0.55, rel = 0.12;
  vGain.gain.setValueAtTime(0.0001, when);
  vGain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + a);
  vGain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * s), when + a + d);
  var relStart = when + Math.max(durSec, a + d + 0.02);
  vGain.gain.setValueAtTime(Math.max(0.0002, peak * s), relStart);
  vGain.gain.exponentialRampToValueAtTime(0.0001, relStart + rel);
  var filt = audioCtx.createBiquadFilter();
  filt.type = 'lowpass'; filt.frequency.value = cutoff; filt.Q.value = 6;
  filt.frequency.setValueAtTime(Math.min(9000, cutoff * 1.4), when);
  filt.frequency.exponentialRampToValueAtTime(Math.max(180, cutoff), when + 0.18);
  filt.connect(vGain);
  vGain.connect(arpMaster);
  if (arpDelaySend) vGain.connect(arpDelaySend);
  pitches.forEach(function (p) {
    if (p == null) return;
    var freq = 440 * Math.pow(2, (p - 69) / 12);
    [-7, 7].forEach(function (detune) {
      var o = audioCtx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = detune;
      o.connect(filt); o.start(when); o.stop(relStart + rel + 0.05);
    });
  });
}

/* ==========================================================================
   MIDI-SINK INTERFACE + implementations
   Interface (duck-typed):
     sendNoteOn(ch,note,vel,time), sendNoteOff(ch,note,time), sendCC(ch,cc,val,time),
     sendClock(time), sendStart(time), sendStop(time), sendContinue(time), ready()->bool
   `time` is ALWAYS AudioContext-domain seconds. Each sink converts as needed.
   ========================================================================== */

/* NoOp sink — default. Audio + export still work; nothing is sent. */
function NoOpSink() {}
NoOpSink.prototype.sendNoteOn = function () {};
NoOpSink.prototype.sendNoteOff = function () {};
NoOpSink.prototype.sendCC = function () {};
NoOpSink.prototype.sendClock = function () {};
NoOpSink.prototype.sendStart = function () {};
NoOpSink.prototype.sendStop = function () {};
NoOpSink.prototype.sendContinue = function () {};
NoOpSink.prototype.ready = function () { return false; };

/* WebMidiSink — ships now. Realtime note stream to a Web MIDI output port.
   CRITICAL: one calibration offset captured at enable converts AudioContext
   seconds -> performance.now() ms. This single line makes synth + Ableton fire
   together. */
function WebMidiSink() {
  this.access = null;
  this.output = null;     // selected MIDIOutput
  this._ready = false;
  this.offset = 0;        // performance.now() - audioCtx.currentTime*1000, captured at enable
  this.lastNoteAt = 0;    // wall-clock ms of last note sent (UI activity flash)
  this._outputs = [];     // [{id,name, port}]
}
WebMidiSink.prototype.enable = function (ctx) {
  var self = this;
  if (!hasMidiAccess()) return Promise.resolve({ ok: false, reason: 'unavailable' });
  return navigator.requestMIDIAccess({ sysex: false }).then(function (access) {
    self.access = access;
    // capture calibration offset: midi ts (ms) = time(s)*1000 + offset
    var ctxNow = ctx ? ctx.currentTime : 0;
    self.offset = nowMs() - ctxNow * 1000;
    self._refreshOutputs();
    access.onstatechange = function () { self._refreshOutputs(); emit('onMidiStatus', api.midi.status()); };
    return { ok: true, outputs: self._outputs.map(function (o) { return { id: o.id, name: o.name }; }) };
  }).catch(function (e) {
    return { ok: false, reason: (e && e.message) || 'denied' };
  });
};
WebMidiSink.prototype._refreshOutputs = function () {
  this._outputs = [];
  if (!this.access) return;
  var outs = this.access.outputs;
  var self = this;
  // MIDIOutputMap is a Map-like
  if (outs && typeof outs.forEach === 'function') {
    outs.forEach(function (port) { self._outputs.push({ id: port.id, name: port.name || port.id, port: port }); });
  }
  // if the currently-selected output vanished (hot-unplug), drop readiness
  if (this.output) {
    var stillThere = this._outputs.some(function (o) { return o.id === self.output.id; });
    if (!stillThere) { this.output = null; this._ready = false; }
  }
};
WebMidiSink.prototype.outputs = function () {
  return this._outputs.map(function (o) { return { id: o.id, name: o.name }; });
};
WebMidiSink.prototype.select = function (id) {
  var found = null;
  for (var i = 0; i < this._outputs.length; i++) { if (this._outputs[i].id === id) { found = this._outputs[i]; break; } }
  if (found) { this.output = found.port; this._ready = true; }
};
WebMidiSink.prototype.ready = function () { return this._ready && !!this.output; };
WebMidiSink.prototype._t = function (time) { return time * 1000 + this.offset; };
WebMidiSink.prototype._send = function (bytes, time) {
  if (!this._ready || !this.output) return;
  try { this.output.send(bytes, this._t(time)); } catch (e) {}
};
WebMidiSink.prototype.sendNoteOn = function (ch, note, vel, time) {
  this._send([0x90 | (ch & 0x0f), note & 127, Math.max(1, vel & 127)], time);
  this.lastNoteAt = nowMs();
};
WebMidiSink.prototype.sendNoteOff = function (ch, note, time) {
  this._send([0x80 | (ch & 0x0f), note & 127, 0], time);
};
WebMidiSink.prototype.sendCC = function (ch, cc, val, time) {
  this._send([0xB0 | (ch & 0x0f), cc & 127, val & 127], time);
};
WebMidiSink.prototype.sendClock = function (time)    { this._send([0xF8], time); };
WebMidiSink.prototype.sendStart = function (time)    { this._send([0xFA], time); };
WebMidiSink.prototype.sendStop = function (time)     { this._send([0xFC], time); };
WebMidiSink.prototype.sendContinue = function (time) { this._send([0xFB], time); };

/* OscSink — PHASE 2 STUB. Documented contract only; all methods no-op + ready()=false.
   KEY DISTINCTION: WebMidiSink streams notes; OscSink is a CLIP-WRITER. The engine
   already produces {pitch,start,dur,vel} tuples, so phase-2 OscSink BUFFERS them into a
   Live clip and flushes on scene-fire instead of streaming. The engine never changes.

   AbletonOSC address mapping (locked here so the contract is fixed):
     transport  -> /live/song/start_playing
                   /live/song/set/tempo <bpm>
     create     -> /live/clip_slot/create_clip <track> <slot> <length_beats>
     notes      -> /live/clip/add/notes <track> <slot> <pitch> <start> <dur> <vel> <mute>
     scene-fire -> /live/clip/fire <track> <slot>   (Live performs its OWN launch-quant)
   Requires the AbletonOSC remote-script + a browser<->OSC bridge (WebSocket -> UDP),
   since browsers cannot speak UDP. Out of v1 scope, fully specified by this stub. */
function OscSink() { this._buffer = []; }
OscSink.prototype.sendNoteOn = function (/* ch, note, vel, time */) {
  // PHASE 2: buffer {pitch,vel,start} into the pending clip; flush via /live/clip/add/notes on scene-fire.
};
OscSink.prototype.sendNoteOff = function (/* ch, note, time */) { /* PHASE 2: pair with the buffered note's duration */ };
OscSink.prototype.sendCC = function () { /* PHASE 2: per-step CC automation lane -> /live/clip/add/notes envelope */ };
OscSink.prototype.sendClock = function () { /* PHASE 2: no per-pulse clock; Live owns the transport */ };
OscSink.prototype.sendStart = function () { /* PHASE 2: -> /live/song/start_playing */ };
OscSink.prototype.sendStop = function () { /* PHASE 2: -> /live/song/stop_playing */ };
OscSink.prototype.sendContinue = function () { /* PHASE 2: -> /live/song/continue_playing */ };
OscSink.prototype.ready = function () { return false; };

/* active sink — starts as no-op, swapped to WebMidiSink on midi.enable() */
var sink = new NoOpSink();
var webMidiSink = null; // lazily created at enable

/* ==========================================================================
   MASTER CLOCK + LOOK-AHEAD SCHEDULER (LOCKED design)
   Accumulator pattern. Tick is the atom; step is derived. ONE timing path.
   ========================================================================== */
var clk = {
  playing: false,
  tick: 0,            // absolute monotonic 96-PPQN tick since start()
  nextTickTime: 0,    // AudioContext seconds for the upcoming tick
  timer: null
};
var pendingLaunches = []; // [{fn, boundaryTick, handle}]

function secPerTick() { return (60 / project.bpm) / PPQN; } // read LIVE each tick (glitch-free tempo)

/* the heartbeat — runs 3 ordered steps per tick. The ONLY place notes get scheduled. */
function emitTick(tick, time) {
  // (1) commit launches whose boundary has arrived (sample-accurate swap)
  if (pendingLaunches.length) {
    var remaining = [];
    for (var i = 0; i < pendingLaunches.length; i++) {
      var L = pendingLaunches[i];
      if (L.boundaryTick <= tick) {
        try { L.fn(); } catch (e) { if (global.console) console.error('[FIRESTARTER] launch fn error', e); }
      } else {
        remaining.push(L);
      }
    }
    pendingLaunches = remaining;
  }

  // (2) MIDI clock (24-PPQN) + raw tick subscribers
  if (project.midi.clockEnabled && tick % MIDI_PULSE_PER_TICK === 0) {
    sink.sendClock(time);
  }
  emit('onTick', tick, time);

  // (3) derived step events — drums at 16th boundaries, arp at its step boundaries.
  //     BOTH read the SAME `tick` accumulator => sample-locked, cannot drift.
  var dc = liveDrum();
  var ac = liveArp();
  var info = { tick: tick, is16th: false, isArpStep: false, drumStep: -1, arpStep: -1 };

  if (dc && tick % TICKS_PER_16TH === 0) {
    var dStep = (tick / TICKS_PER_16TH) % dc.steps;
    info.is16th = true; info.drumStep = dStep;
    fireDrumStep(dc, dStep, time);
  }
  if (ac && ac._suppressed !== true) {
    var tpa = ticksPerArpStep(ac);
    if (tick % tpa === 0) {
      var aStep = (tick / tpa) % ac.steps;
      info.isArpStep = true; info.arpStep = aStep;
      fireArpStep(ac, aStep, time);
    }
  }
  emit('onStep', info, time);
}

/* DRUM consumer — one 16th step. swingOffset applied at send time. */
function fireDrumStep(dc, stepIndex, time) {
  var swing = project.swing;
  var secPer16 = (60 / project.bpm) / 4;
  var swingOff = (stepIndex % 2 === 1) ? secPer16 * (swing / 100) * 0.5 : 0;
  var drumCh = project.midi.drumCh;
  VOICES.forEach(function (v) {
    var lvl = dc.pattern[v.id][stepIndex];
    if (!lvl) return;
    if (!isAudible(dc, v.id)) return;
    var vel = LEVEL_VEL[lvl];
    var t = time + swingOff;
    if (dc.human[v.id]) {
      t += (Math.random() - 0.5) * 0.024;
      vel = clamp(vel + Math.round((Math.random() - 0.5) * 24), 1, 127);
    }
    var ct = audioTime();
    if (t < ct) t = ct + 0.001;
    synthDrum(v, t, vel);
    // sink: note-on now, note-off after the voice's duration (beats -> sec)
    var durSec = v.dur * (60 / project.bpm);
    sink.sendNoteOn(drumCh, v.note, vel, t);
    sink.sendNoteOff(drumCh, v.note, t + durSec);
  });
  if (sink.lastNoteAt) emit('onMidiActivity', sink.lastNoteAt);
}

/* ARP consumer — one arp step. Resolves the pitch(es) for this step index. */
var _arpCycleCache = { sig: null, cycle: null, mathSig: null, program: null };
var _arpLastPitches = [];   // HOLD: last pitches actually sounded (latched across rests)
function fireArpStep(ac, stepIndex, time) {
  var manualRest = (ac.pattern[stepIndex] === false);
  var pitches;

  // ---- MATH STYLE BRANCH (window.ARP_STYLES) ----
  if (isMathMode(ac.mode)) {
    var msig = mathProgramSig(ac);
    if (_arpCycleCache.mathSig !== msig) {
      _arpCycleCache.mathSig = msig;
      _arpCycleCache.program = buildMathProgram(ac);
    }
    var prog = _arpCycleCache.program;
    var li = (prog.pitches.length) ? (stepIndex % prog.pitches.length) : 0; // loop the length-N program
    var styleRest = prog.rests[li];
    var isRestM = manualRest || styleRest;
    if (isRestM && !ac.hold) return;
    if (isRestM && ac.hold) {
      pitches = _arpLastPitches.slice();           // latch previous
    } else {
      var mp = prog.pitches[li];
      pitches = (mp == null) ? [] : [mp];
    }
    if (!pitches.length) return;
    _arpLastPitches = pitches.slice();
    var swingM = project.swing;
    var slM = stepLengthBeats(ac);
    var secPerStepM = slM * (60 / project.bpm);
    var swingOffM = (stepIndex % 2 === 1) ? secPerStepM * (swingM / 100) * 0.5 : 0;
    var styleVelM = prog.velocities[li] != null ? prog.velocities[li] : 100;
    var manualVelM = ac.velocities[stepIndex] != null ? ac.velocities[stepIndex] : 100;
    var velM = Math.max(1, Math.min(127, Math.round(styleVelM * (manualVelM / 100))));
    var durSecM = Math.max(0.001, (ac.gate / 100) * secPerStepM);
    var tM = time + swingOffM;
    var ctM = audioTime();
    if (tM < ctM) tM = ctM + 0.001;
    synthArp(pitches, velM, tM, durSecM, ac.cutoff);
    var arpChM = project.midi.arpCh;
    for (var ii = 0; ii < pitches.length; ii++) {
      sink.sendNoteOn(arpChM, pitches[ii], velM, tM);
      sink.sendNoteOff(arpChM, pitches[ii], tM + durSecM);
    }
    if (sink.lastNoteAt) emit('onMidiActivity', sink.lastNoteAt);
    return;
  }

  // ---- EXISTING (built-in) MODES — unchanged ----
  var isRest = manualRest;
  // HOLD off + rest = silence. HOLD on + rest = latch (sustain) the previous pitch(es).
  if (isRest && !ac.hold) return;
  // build (cached) cycle for this clip
  var sig = ac.root + '|' + ac.type + '|' + ac.octaves + '|' + ac.mode + '|' + (ac.customNotes || []).join(',');
  if (_arpCycleCache.sig !== sig) {
    _arpCycleCache.sig = sig;
    _arpCycleCache.cycle = buildArpCycle(ac, getStackedPitches(ac));
  }
  var cycle = _arpCycleCache.cycle;
  if (isRest && ac.hold) {
    // latch: re-sound whatever last played (no advance through the cycle)
    pitches = _arpLastPitches.slice();
  } else if (ac.mode === 'chord') {
    pitches = cycle[0] ? cycle[0].slice() : [];
  } else {
    var idx = cycle.length ? (stepIndex % cycle.length) : 0;
    var p = cycle.length ? cycle[idx] : null;
    pitches = (p == null) ? [] : [p];
  }
  if (!pitches.length) return;
  _arpLastPitches = pitches.slice(); // remember for the next latched rest
  var swing = project.swing;
  var sl = stepLengthBeats(ac);
  var secPerStep = sl * (60 / project.bpm);
  var swingOff = (stepIndex % 2 === 1) ? secPerStep * (swing / 100) * 0.5 : 0;
  var vel = ac.velocities[stepIndex] != null ? ac.velocities[stepIndex] : 100;
  var durSec = Math.max(0.001, (ac.gate / 100) * secPerStep);
  var t = time + swingOff;
  var ct = audioTime();
  if (t < ct) t = ct + 0.001;
  synthArp(pitches, vel, t, durSec, ac.cutoff);
  var arpCh = project.midi.arpCh;
  for (var i = 0; i < pitches.length; i++) {
    sink.sendNoteOn(arpCh, pitches[i], vel, t);
    sink.sendNoteOff(arpCh, pitches[i], t + durSec);
  }
  if (sink.lastNoteAt) emit('onMidiActivity', sink.lastNoteAt);
}

/* the wake loop: accumulator. Schedules every tick due within the look-ahead window. */
function scheduler() {
  if (!clk.playing) return;
  var ahead = audioTime() + SCHEDULE_AHEAD;
  while (clk.nextTickTime < ahead) {
    emitTick(clk.tick, clk.nextTickTime);
    clk.tick++;
    clk.nextTickTime += secPerTick();
  }
  clk.timer = setTimeout(scheduler, LOOKAHEAD_MS);
}

function transportStart() {
  ensureAudio();
  if (clk.playing) return;
  clk.playing = true;
  clk.tick = 0;
  clk.nextTickTime = audioTime() + START_LATENCY;
  sink.sendStart(clk.nextTickTime);
  // sync arp delay to ~dotted-8th for musical space (ported behaviour)
  if (arpDelay) arpDelay.delayTime.value = Math.min(1.9, 0.75 * (60 / project.bpm));
  scheduler();
  emit('onTransport', { playing: true });
}
function transportStop() {
  if (!clk.playing && !clk.timer) { emit('onTransport', { playing: false }); }
  clk.playing = false;
  if (clk.timer) { clearTimeout(clk.timer); clk.timer = null; }
  pendingLaunches = [];
  sink.sendStop(audioTime());
  emit('onTransport', { playing: false });
}
function transportContinue() {
  ensureAudio();
  if (clk.playing) return;
  clk.playing = true;
  clk.nextTickTime = audioTime() + START_LATENCY;
  sink.sendContinue(clk.nextTickTime);
  scheduler();
  emit('onTransport', { playing: true, resumed: true });
}

/* ==========================================================================
   LAUNCH-QUANTIZE ENGINE — serves BOTH scenes AND clips (one engine)
   ========================================================================== */
function scheduleLaunch(fn, quantize) {
  var q = (quantize === undefined) ? project.launchQuant : quantize;
  if (q === 'instant' || !clk.playing) { fn(); return null; }
  var bars = (q === 1 || q === 2 || q === 4) ? q : 1;
  var span = TICKS_PER_BAR * bars;
  var boundaryTick = (Math.floor(clk.tick / span) + 1) * span;
  var handle = { fn: fn, boundaryTick: boundaryTick, id: uid('launch') };
  pendingLaunches.push(handle);
  emit('onLaunch', { boundaryTick: boundaryTick, handle: handle });
  return handle;
}
function cancelLaunch(handle) {
  if (!handle) return;
  var i = pendingLaunches.indexOf(handle);
  if (i >= 0) { pendingLaunches.splice(i, 1); emit('onLaunchCancel', handle); }
}

/* ==========================================================================
   CLIP POOL OPERATIONS
   ========================================================================== */
function poolFor(kind) { return kind === 'drum' ? project.drumClips : project.arpClips; }

function snapshotLiveDrum(name, fromLive) {
  var src = fromLive === false ? liveDrum() : liveDrum();
  var copy = deepCopy(src);
  copy.id = uid('drum');
  copy.name = name || (src.name + ' copy');
  return copy;
}
function snapshotLiveArp(name) {
  var src = liveArp();
  var copy = deepCopy(src);
  copy.id = uid('arp');
  copy.name = name || (src.name + ' copy');
  return copy;
}

/* ==========================================================================
   PUBLIC API — window.FIRESTARTER. Implements the locked contract EXACTLY.
   ========================================================================== */
var _initialized = false;

var api = {
  /* ---- boot ---- */
  init: function (opts) {
    opts = opts || {};
    if (!_initialized) {
      persistLoad(); // restore project if present (else defaults)
      _initialized = true;
    }
    if (opts.bpm != null) project.bpm = clamp(opts.bpm | 0, 20, 400);
    if (opts.swing != null) project.swing = clamp(opts.swing | 0, 0, 70);
    if (opts.drumCh != null) project.midi.drumCh = clamp(opts.drumCh | 0, 0, 15);
    if (opts.arpCh != null) project.midi.arpCh = clamp(opts.arpCh | 0, 0, 15);
    persistSave();
    emit('onInit', api.snapshot());
  },

  /* ---- clock / transport ---- */
  clock: {
    start: function () { transportStart(); },
    stop: function () { transportStop(); },
    continue: function () { transportContinue(); },
    setBpm: function (bpm) { project.bpm = clamp(bpm, 20, 400); persistSave(); emit('onBpm', project.bpm); },
    getBpm: function () { return project.bpm; },
    getTick: function () { return clk.tick; },
    isPlaying: function () { return clk.playing; },
    onTick: function (cb) { return on('onTick', cb); },
    offTick: function (cb) { off('onTick', cb); },
    onStep: function (cb) { return on('onStep', cb); },
    offStep: function (cb) { off('onStep', cb); },
    /* position helpers (derived from tick) */
    getPosition: function () {
      var bar = Math.floor(clk.tick / TICKS_PER_BAR);
      var beat = Math.floor((clk.tick % TICKS_PER_BAR) / PPQN);
      var step16 = Math.floor((clk.tick % TICKS_PER_BAR) / TICKS_PER_16TH);
      return { bar: bar, beat: beat, step16: step16, tick: clk.tick };
    },
    PPQN: PPQN,
    TICKS_PER_BAR: TICKS_PER_BAR
  },

  /* ---- global swing + launch quant ---- */
  setSwing: function (pct) { project.swing = clamp(pct, 0, 70); persistSave(); emit('onSwing', project.swing); },
  getSwing: function () { return project.swing; },
  setLaunchQuant: function (q) {
    if (q === 'instant' || q === 1 || q === 2 || q === 4) { project.launchQuant = q; persistSave(); emit('onLaunchQuant', q); }
  },
  getLaunchQuant: function () { return project.launchQuant; },

  /* ---- launch engine (exposed for the UI ring) ---- */
  scheduleLaunch: scheduleLaunch,
  cancelLaunch: cancelLaunch,

  /* ---- DRUMS ---- */
  drums: {
    getPattern: function () {
      var dc = liveDrum();
      return {
        pattern: dc.pattern, mute: dc.mute, solo: dc.solo, human: dc.human,
        steps: dc.steps, lengthBars: dc.lengthBars
      };
    },
    setCell: function (voiceId, step, level) {
      var dc = liveDrum();
      if (!dc.pattern[voiceId] || step < 0 || step >= dc.steps) return;
      dc.pattern[voiceId][step] = clamp(level | 0, 0, 3);
      persistSave();
      if (!clk.playing && level) {
        var v = VOICES.filter(function (x) { return x.id === voiceId; })[0];
        if (v) synthDrum(v, audioTime() + 0.01, LEVEL_VEL[level] || 100);
      }
      emit('onDrumChange', { voiceId: voiceId, step: step, level: level });
    },
    setLengthBars: function (bars) {
      var dc = liveDrum();
      bars = clamp(bars | 0, 1, 16);
      var newSteps = 16 * bars, old = dc.steps;
      VOICES.forEach(function (v) {
        var oldRow = dc.pattern[v.id] || [];
        var row = new Array(newSteps).fill(0);
        if (newSteps >= old) { for (var i = 0; i < newSteps; i++) row[i] = oldRow[i % old] || 0; }
        else { for (var j = 0; j < newSteps; j++) row[j] = oldRow[j] || 0; }
        dc.pattern[v.id] = row;
      });
      dc.steps = newSteps; dc.lengthBars = bars;
      persistSave(); emit('onDrumChange', { resized: true, lengthBars: bars });
    },
    setMuteSolo: function (voiceId, kind, on2) {
      var dc = liveDrum();
      if (kind === 'mute') dc.mute[voiceId] = !!on2;
      else if (kind === 'solo') dc.solo[voiceId] = !!on2;
      persistSave(); emit('onDrumChange', { voiceId: voiceId, kind: kind, on: on2 });
    },
    setHuman: function (voiceId, on2) {
      var dc = liveDrum(); dc.human[voiceId] = !!on2; persistSave();
      emit('onDrumChange', { voiceId: voiceId, kind: 'human', on: on2 });
    },
    audition: function (voiceId) {
      var v = VOICES.filter(function (x) { return x.id === voiceId; })[0];
      if (v) synthDrum(v, audioTime() + 0.01, 110);
    },
    clearRow: function (voiceId) {
      var dc = liveDrum();
      if (dc.pattern[voiceId]) dc.pattern[voiceId] = new Array(dc.steps).fill(0);
      persistSave(); emit('onDrumChange', { voiceId: voiceId, cleared: true });
    },
    clearAll: function () {
      var dc = liveDrum();
      VOICES.forEach(function (v) { dc.pattern[v.id] = new Array(dc.steps).fill(0); });
      persistSave(); emit('onDrumChange', { clearedAll: true });
    },
    getVoices: function () { return VOICES.map(function (v) { return { id: v.id, name: v.name, note: v.note, dur: v.dur }; }); }
  },

  /* ---- ARP ---- */
  arp: {
    getClip: function () { return liveArp(); },
    setParam: function (key, value) {
      var ac = liveArp();
      switch (key) {
        case 'root': ac.root = clamp(value | 0, 0, 11); break;
        case 'type': if (CHORD_TYPES[value]) ac.type = value; break;
        case 'octaves': ac.octaves = clamp(value | 0, 1, 4); break;
        case 'mode': ac.mode = value; break;
        case 'rate':
          ac.rate = value;
          // re-fit step count to the clip length at the new rate
          var fitted = computeArpSteps(ac.lengthBars, value);
          resizeArpArrays(ac, fitted);
          break;
        case 'gate': ac.gate = clamp(value | 0, 1, 100); break;
        case 'cutoff': ac.cutoff = clamp(value | 0, 80, 12000); break;
        case 'hold': ac.hold = !!value; break;
        case 'customNotes': ac.customNotes = (value || []).slice(); break;
        case 'seed': ac.seed = (value | 0) || 1; break;
        default: return;
      }
      _arpCycleCache.sig = null;     // invalidate cached cycle
      _arpCycleCache.mathSig = null; // invalidate cached math program
      persistSave(); emit('onArpChange', { key: key, value: value });
    },
    /* set a single math-style param for the current clip's mode */
    setStyleParam: function (name, value) {
      var ac = liveArp();
      if (!isMathMode(ac.mode)) return;
      ac.styleParams = ac.styleParams || {};
      ac.styleParams[ac.mode] = ac.styleParams[ac.mode] || {};
      ac.styleParams[ac.mode][name] = value;
      _arpCycleCache.mathSig = null;
      persistSave(); emit('onArpChange', { key: 'styleParam:' + name, value: value });
    },
    /* read resolved math-style params (defaults filled) for the current clip */
    getStyleParams: function () {
      var ac = liveArp();
      return isMathMode(ac.mode) ? styleParamsFor(ac) : {};
    },
    /* enumerate available math styles grouped data for UI */
    getMathStyles: function () {
      var S = _ARP_STYLES();
      if (!S) return [];
      return Object.keys(S).map(function (k) {
        var st = S[k];
        return { key: st.key, label: st.label, family: st.family, params: st.params };
      });
    },
    setStep: function (step, on2, velocity) {
      var ac = liveArp();
      if (step < 0 || step >= ac.steps) return;
      ac.pattern[step] = !!on2;
      if (velocity != null) ac.velocities[step] = clamp(velocity | 0, 1, 127);
      persistSave();
      if (!clk.playing && on2) {
        // audition this step's pitch
        var pitches;
        if (isMathMode(ac.mode)) {
          var progA = buildMathProgram(ac);
          var liA = progA.pitches.length ? (step % progA.pitches.length) : 0;
          var mpA = progA.rests[liA] ? null : progA.pitches[liA];
          pitches = (mpA == null) ? [] : [mpA];
        } else {
          var cyc = buildArpCycle(ac, getStackedPitches(ac));
          pitches = ac.mode === 'chord' ? (cyc[0] || []) : (cyc.length ? [cyc[step % cyc.length]] : []);
        }
        if (pitches.length) synthArp(pitches, ac.velocities[step] || 100, audioTime() + 0.01, 0.2, ac.cutoff);
      }
      emit('onArpChange', { step: step, on: on2, velocity: velocity });
    },
    setLengthBars: function (bars) {
      var ac = liveArp();
      bars = clamp(bars | 0, 1, 16);
      var newSteps = computeArpSteps(bars, ac.rate);
      var oldBars = ac.lengthBars;
      var oldStepsPerBar = ac.steps / oldBars;
      resizeArpArraysPreservingBars(ac, bars, oldBars, oldStepsPerBar, newSteps);
      ac.lengthBars = bars; ac.steps = newSteps;
      persistSave(); emit('onArpChange', { resized: true, lengthBars: bars });
    },
    duplicateBar: function (srcBar) {
      var ac = liveArp();
      var spb = ac.steps / ac.lengthBars;
      if (srcBar < 0 || srcBar >= ac.lengthBars) return;
      var start = srcBar * spb;
      for (var i = 0; i < spb; i++) {
        ac.pattern.push(ac.pattern[start + i]);
        ac.velocities.push(ac.velocities[start + i]);
      }
      ac.lengthBars += 1; ac.steps += spb;
      persistSave(); emit('onArpChange', { duplicatedBar: srcBar });
    },
    clearBar: function (bar) {
      var ac = liveArp();
      var spb = ac.steps / ac.lengthBars;
      if (bar < 0 || bar >= ac.lengthBars) return;
      var start = bar * spb;
      for (var i = 0; i < spb; i++) { ac.pattern[start + i] = false; }
      persistSave(); emit('onArpChange', { clearedBar: bar });
    },
    /* expose theory helpers for the UI (keyboard / resolved readout / piano-roll) */
    getStackedPitches: function () { return getStackedPitches(liveArp()); },
    getChordBasePitches: function () { return getChordBasePitches(liveArp()); },
    buildCycle: function () { var ac = liveArp(); return buildArpCycle(ac, getStackedPitches(ac)); },
    stepLengthBeats: function () { return stepLengthBeats(liveArp()); },
    midiName: midiName,
    NOTE_NAMES: NOTE_NAMES,
    CHORD_TYPES: CHORD_TYPES
  },

  /* ---- CLIPS (shared pools) ---- */
  clips: {
    saveDrum: function (name, fromLive) {
      var copy = snapshotLiveDrum(name, fromLive);
      project.drumClips[copy.id] = copy;
      persistSave(); emit('onClips', { kind: 'drum', id: copy.id });
      return copy.id;
    },
    saveArp: function (name, fromLive) {
      var copy = snapshotLiveArp(name, fromLive);
      project.arpClips[copy.id] = copy;
      persistSave(); emit('onClips', { kind: 'arp', id: copy.id });
      return copy.id;
    },
    list: function (kind) {
      var pool = poolFor(kind);
      return Object.keys(pool).map(function (id) {
        var c = pool[id];
        return { id: id, name: c.name, lengthBars: c.lengthBars };
      });
    },
    get: function (kind, id) { return poolFor(kind)[id] || null; },
    launch: function (kind, id, quantize) {
      var pool = poolFor(kind);
      if (!pool[id]) return null;
      var handle = scheduleLaunch(function () {
        if (kind === 'drum') {
          project.liveDrumClipId = id;
          var dc = liveDrum(); if (dc) dc._suppressed = false; // re-launch a previously-stopped drum clip must un-mute it
        } else {
          project.liveArpClipId = id; var ac = liveArp(); if (ac) ac._suppressed = false; _arpCycleCache.sig = null; _arpCycleCache.mathSig = null;
        }
        persistSave();
        emit('onClipLaunched', { kind: kind, id: id });
      }, quantize);
      emit('onClipQueued', { kind: kind, id: id, handle: handle });
      return handle;
    },
    stop: function (kind, quantize) {
      var handle = scheduleLaunch(function () {
        if (kind === 'arp') { var ac = liveArp(); if (ac) ac._suppressed = true; }
        // drums: there is always a live drum clip; "stop" mutes it by clearing audibility transiently.
        // Cleaner model: suppress via a flag the consumer checks.
        if (kind === 'drum') { var dc = liveDrum(); if (dc) dc._suppressed = true; }
        emit('onClipStopped', { kind: kind });
      }, quantize);
      emit('onClipQueuedStop', { kind: kind, handle: handle });
      return handle;
    },
    delete: function (kind, id) {
      var pool = poolFor(kind);
      delete pool[id];
      // null out scene references
      project.scenes.forEach(function (s) {
        if (kind === 'drum' && s.drumClipId === id) s.drumClipId = null;
        if (kind === 'arp' && s.arpClipId === id) s.arpClipId = null;
      });
      // keep live ids valid
      migrateProject(project);
      persistSave(); emit('onClips', { kind: kind, deleted: id });
    },
    fork: function (kind, id) {
      var pool = poolFor(kind);
      if (!pool[id]) return null;
      var copy = deepCopy(pool[id]);
      copy.id = uid(kind);
      copy.name = pool[id].name + ' fork';
      pool[copy.id] = copy;
      persistSave(); emit('onClips', { kind: kind, forked: copy.id });
      return copy.id;
    }
  },

  /* ---- SCENES ---- */
  scenes: {
    list: function () { return project.scenes.slice(); },
    capture: function (name) {
      // snapshot REFERENCES to the current live clips + key settings (the headline move)
      var n = name || ('Scene ' + String.fromCharCode(65 + (project.scenes.length % 26)));
      var scene = {
        id: uid('scene'),
        name: n,
        color: null,
        drumClipId: project.liveDrumClipId,
        arpClipId: project.liveArpClipId,
        bpm: project.bpm,
        swing: project.swing
      };
      project.scenes.push(scene);
      persistSave(); emit('onSceneChange', { captured: scene.id });
      return scene.id;
    },
    save: function (scene) {
      scene = scene || {};
      if (scene.id) {
        var existing = project.scenes.filter(function (s) { return s.id === scene.id; })[0];
        if (existing) { Object.assign(existing, scene); persistSave(); emit('onSceneChange', { updated: scene.id }); return scene.id; }
      }
      var s = {
        id: uid('scene'),
        name: scene.name || ('Scene ' + (project.scenes.length + 1)),
        color: scene.color || null,
        drumClipId: scene.drumClipId != null ? scene.drumClipId : project.liveDrumClipId,
        arpClipId: scene.arpClipId !== undefined ? scene.arpClipId : project.liveArpClipId,
        bpm: scene.bpm, swing: scene.swing, launchQuantOverride: scene.launchQuantOverride
      };
      project.scenes.push(s);
      persistSave(); emit('onSceneChange', { created: s.id });
      return s.id;
    },
    launch: function (id, quantize) {
      var scene = project.scenes.filter(function (s) { return s.id === id; })[0];
      if (!scene) return null;
      project.queuedSceneId = id;
      emit('onSceneChange', { queued: id });
      var q = quantize !== undefined ? quantize : (scene.launchQuantOverride !== undefined ? scene.launchQuantOverride : undefined);
      var handle = scheduleLaunch(function () {
        // swap live clips at the boundary (auto-stops previous scene's clips by replacement)
        if (scene.drumClipId && project.drumClips[scene.drumClipId]) {
          project.liveDrumClipId = scene.drumClipId;
          var dc = liveDrum(); if (dc) dc._suppressed = false;
        }
        if (scene.arpClipId && project.arpClips[scene.arpClipId]) {
          project.liveArpClipId = scene.arpClipId;
          var ac = liveArp(); if (ac) ac._suppressed = false;
          _arpCycleCache.sig = null; _arpCycleCache.mathSig = null;
        } else if (scene.arpClipId === null) {
          var ac2 = liveArp(); if (ac2) ac2._suppressed = true; // explicit silent arp
        }
        if (scene.bpm) project.bpm = scene.bpm;
        if (scene.swing != null) project.swing = scene.swing;
        project.activeSceneId = id;
        project.queuedSceneId = null;
        persistSave();
        emit('onSceneChange', { active: id });
      }, q);
      return handle;
    },
    rename: function (id, name) {
      var s = project.scenes.filter(function (x) { return x.id === id; })[0];
      if (s) { s.name = name; persistSave(); emit('onSceneChange', { renamed: id }); }
    },
    delete: function (id) {
      project.scenes = project.scenes.filter(function (s) { return s.id !== id; });
      if (project.activeSceneId === id) project.activeSceneId = null;
      persistSave(); emit('onSceneChange', { deleted: id });
    },
    duplicate: function (id, fork) {
      var s = project.scenes.filter(function (x) { return x.id === id; })[0];
      if (!s) return null;
      var copy = deepCopy(s); copy.id = uid('scene'); copy.name = s.name + ' copy';
      if (fork) {
        if (copy.drumClipId && project.drumClips[copy.drumClipId]) copy.drumClipId = api.clips.fork('drum', copy.drumClipId);
        if (copy.arpClipId && project.arpClips[copy.arpClipId]) copy.arpClipId = api.clips.fork('arp', copy.arpClipId);
      }
      project.scenes.push(copy);
      persistSave(); emit('onSceneChange', { duplicated: copy.id });
      return copy.id;
    },
    getActive: function () { return project.activeSceneId; },
    getQueued: function () { return project.queuedSceneId; }
  },

  /* ---- MIDI ---- */
  midi: {
    enable: function () {
      ensureAudio();
      if (!hasMidiAccess()) {
        emit('onMidiStatus', api.midi.status());
        return Promise.resolve({ ok: false, outputs: [] });
      }
      if (!webMidiSink) webMidiSink = new WebMidiSink();
      return webMidiSink.enable(audioCtx).then(function (res) {
        if (res.ok) {
          sink = webMidiSink; // engine now streams to Web MIDI
          // auto-select a saved port, or the first 'IAC' port
          var outs = webMidiSink.outputs();
          var pick = null;
          if (project.midi.outId) pick = outs.filter(function (o) { return o.id === project.midi.outId; })[0];
          if (!pick) pick = outs.filter(function (o) { return /IAC/i.test(o.name); })[0];
          if (pick) { webMidiSink.select(pick.id); project.midi.outId = pick.id; persistSave(); }
        }
        emit('onMidiStatus', api.midi.status());
        return { ok: !!res.ok, outputs: webMidiSink.outputs() };
      });
    },
    outputs: function () { return webMidiSink ? webMidiSink.outputs() : []; },
    selectOutput: function (id) {
      if (!webMidiSink) return;
      webMidiSink.select(id);
      project.midi.outId = id;
      persistSave();
      emit('onMidiStatus', api.midi.status());
    },
    setChannels: function (cfg) {
      cfg = cfg || {};
      if (cfg.drumCh != null) project.midi.drumCh = clamp(cfg.drumCh | 0, 0, 15);
      if (cfg.arpCh != null) project.midi.arpCh = clamp(cfg.arpCh | 0, 0, 15);
      persistSave(); emit('onMidiStatus', api.midi.status());
    },
    setClockEnabled: function (on2) {
      project.midi.clockEnabled = !!on2; persistSave(); emit('onMidiStatus', api.midi.status());
    },
    status: function () {
      var ready = !!(webMidiSink && webMidiSink.ready());
      var outName = null;
      if (webMidiSink && webMidiSink.output) outName = webMidiSink.output.name || webMidiSink.output.id;
      return {
        available: hasMidiAccess(),
        enabled: !!(webMidiSink && webMidiSink.access),
        ready: ready,
        outName: outName,
        drumCh: project.midi.drumCh,
        arpCh: project.midi.arpCh,
        clockEnabled: project.midi.clockEnabled,
        lastNoteAt: webMidiSink ? webMidiSink.lastNoteAt : 0
      };
    },
    /* phase-2 entry point: swap in the OscSink (no engine change). Documented, inert. */
    _useOscSink: function () { sink = new OscSink(); emit('onMidiStatus', api.midi.status()); }
  },

  /* ---- FILE EXPORT (all routed through verified buildMidi) ---- */
  export: {
    drums: function () {
      var dc = liveDrum();
      var notes = gatherDrumNotes(dc, project.swing, 9);
      return buildMidi(notes, { bpm: project.bpm, ppq: 480, trackName: 'EMITR FIRESTARTER DRUMS' });
    },
    arp: function () {
      var ac = liveArp();
      var notes = resolveArpNotes(ac, project.swing, 1);
      return buildMidi(notes, { bpm: project.bpm, ppq: 480, trackName: 'EMITR FIRESTARTER ARP' });
    },
    scene: function (sceneId) {
      var drumClip, arpClip;
      if (sceneId) {
        var sc = project.scenes.filter(function (s) { return s.id === sceneId; })[0];
        drumClip = sc && sc.drumClipId ? project.drumClips[sc.drumClipId] : null;
        arpClip = sc && sc.arpClipId ? project.arpClips[sc.arpClipId] : null;
      } else if (project.activeSceneId) {
        var ac0 = project.scenes.filter(function (s) { return s.id === project.activeSceneId; })[0];
        drumClip = ac0 && ac0.drumClipId ? project.drumClips[ac0.drumClipId] : liveDrum();
        arpClip = ac0 && ac0.arpClipId ? project.arpClips[ac0.arpClipId] : liveArp();
      } else {
        drumClip = liveDrum(); arpClip = liveArp();
      }
      var notes = [];
      if (drumClip) notes = notes.concat(gatherDrumNotes(drumClip, project.swing, 9));
      if (arpClip) notes = notes.concat(resolveArpNotes(arpClip, project.swing, 1));
      return buildMidi(notes, { bpm: project.bpm, ppq: 480, trackName: 'EMITR FIRESTARTER SCENE' });
    },
    /* expose the encoder + a helper for the UI download */
    buildMidi: buildMidi
  },

  /* ---- PERSISTENCE ---- */
  persist: {
    save: function () { persistSave(); },
    load: function () { return persistLoad(); },
    exportJSON: function () { return JSON.stringify(project, null, 2); },
    importJSON: function (json) {
      try {
        var obj = JSON.parse(json);
        if (obj && obj.v) { migrateProject(obj); project = obj; persistSave(); emit('onImport', api.snapshot()); return true; }
      } catch (e) {}
      return false;
    }
  },

  /* ---- PANIC ---- */
  panic: function () {
    transportStop();
    pendingLaunches = [];
    // all-notes-off on both channels
    var t = audioTime();
    for (var ch = 0; ch < 16; ch++) {
      if (ch === project.midi.drumCh || ch === project.midi.arpCh) {
        sink.sendCC(ch, 123, 0, t); // All Notes Off
        sink.sendCC(ch, 120, 0, t); // All Sound Off
      }
    }
    emit('onPanic', {});
  },

  /* ---- event subscription (UI hooks) ---- */
  on: on,
  off: off,

  /* ---- read-only state snapshot for the UI ---- */
  snapshot: function () {
    var dc = liveDrum(), ac = liveArp();
    return {
      bpm: project.bpm, swing: project.swing, launchQuant: project.launchQuant,
      playing: clk.playing, tick: clk.tick,
      liveDrumClipId: project.liveDrumClipId, liveArpClipId: project.liveArpClipId,
      // suppressed = a launched-then-stopped clip is silently held; UI shows STOPPED, not PLAYING
      drumSuppressed: !!(dc && dc._suppressed),
      arpSuppressed: !!(ac && ac._suppressed),
      activeSceneId: project.activeSceneId, queuedSceneId: project.queuedSceneId,
      midi: deepCopy(project.midi),
      sceneCount: project.scenes.length,
      drumClipCount: Object.keys(project.drumClips).length,
      arpClipCount: Object.keys(project.arpClips).length
    };
  },

  /* ---- constants / introspection ---- */
  VOICES: VOICES,
  CHORD_TYPES: CHORD_TYPES,
  NOTE_NAMES: NOTE_NAMES,
  PPQN: PPQN,
  _project: function () { return project; } // dev/debug access
};

/* ---- arp array resize helpers ---- */
function resizeArpArrays(ac, newSteps) {
  var oldPat = ac.pattern || [], oldVel = ac.velocities || [];
  var pat = new Array(newSteps), vel = new Array(newSteps);
  for (var i = 0; i < newSteps; i++) {
    pat[i] = (i < oldPat.length) ? oldPat[i] : (oldPat.length ? oldPat[i % oldPat.length] : true);
    vel[i] = (i < oldVel.length) ? oldVel[i] : 100;
  }
  ac.pattern = pat; ac.velocities = vel; ac.steps = newSteps;
}
/* grow/shrink by whole bars; new bars repeat the previous bar's content */
function resizeArpArraysPreservingBars(ac, newBars, oldBars, oldStepsPerBar, newSteps) {
  var newSpb = newSteps / newBars;
  var oldPat = ac.pattern || [], oldVel = ac.velocities || [];
  var pat = new Array(newSteps), vel = new Array(newSteps);
  for (var b = 0; b < newBars; b++) {
    for (var s = 0; s < newSpb; s++) {
      var dst = b * newSpb + s;
      if (b < oldBars) {
        var src = b * oldStepsPerBar + Math.min(s, oldStepsPerBar - 1);
        pat[dst] = (oldPat[src] !== undefined) ? oldPat[src] : true;
        vel[dst] = (oldVel[src] !== undefined) ? oldVel[src] : 100;
      } else {
        // repeat the last existing bar
        var refBar = oldBars - 1;
        var src2 = refBar * oldStepsPerBar + Math.min(s, oldStepsPerBar - 1);
        pat[dst] = (oldPat[src2] !== undefined) ? oldPat[src2] : true;
        vel[dst] = (oldVel[src2] !== undefined) ? oldVel[src2] : 100;
      }
    }
  }
  ac.pattern = pat; ac.velocities = vel;
}

/* ==========================================================================
   EXPORT — window.FIRESTARTER (browser) + module.exports (Node test harness)
   ========================================================================== */
if (HAS_WINDOW) { global.FIRESTARTER = api; }
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
  // expose internals for headless unit tests
  module.exports._internals = {
    buildMidi: buildMidi, buildArpCycle: buildArpCycle, getStackedPitches: getStackedPitches,
    stepLengthBeats: stepLengthBeats, resolveArpNotes: resolveArpNotes, gatherDrumNotes: gatherDrumNotes,
    computeArpSteps: computeArpSteps, defaultProject: defaultProject, ticksPerArpStep: ticksPerArpStep,
    isMathMode: isMathMode, buildMathProgram: buildMathProgram, styleParamsFor: styleParamsFor,
    defaultArpClip: defaultArpClip,
    PPQN: PPQN, TICKS_PER_BAR: TICKS_PER_BAR
  };
}

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
