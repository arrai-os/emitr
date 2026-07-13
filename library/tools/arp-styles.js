/*
 * arp-styles.js — shared math-based arpeggiator style registry.
 *
 * window.ARP_STYLES = { <key>: styleObject, ... }
 * Also require()-able under Node (all window access guarded).
 *
 * Wrapped in an IIFE that defines bit-exact shared helpers
 * (mulberry32 PRNG, clampInt, pmod, popcount) + the STYLES registry.
 * window.ARP_STYLES_API exposes { STYLES, mulberry32, clampInt, pmod, keys }.
 *
 * Each style implements the LOCKED contract:
 *   { key, label, family, params:[...], gen(pool, opts) -> Array<StepObject> }
 *   StepObject = { idx:int|null, octShift:int, vel:int }
 *   gen is DETERMINISTIC given (pool.length, opts).
 *
 * REST CONTRACT (vel on rests): when idx===null the step is a REST. On a rest
 * octShift and vel are IGNORED by every consumer (the adapter keys solely off
 * idx===null and never reads vel on a rest — see applyArpStyle in arpeggiator.html
 * + firestarter-core.js). Styles MAY therefore emit vel:0 (or omit vel) on rest
 * steps; the strict [1,127] velocity range applies ONLY to sounding steps
 * (idx!==null). euclidean/pink emit vel:0 on rests by this convention.
 *
 * Optional param field `uiLabel`: when present the tools render it as the param's
 * display label instead of `name` (name stays the opts key). Lets a param read
 * differently in the UI without changing its key — e.g. pink's `octaves` shows as
 * 'sources (K)' since on pink it controls noise color, not register.
 *
 * SELF-TEST: load this module under Node and call _selfTest() (exported below) —
 * it runs every gen against the StepObject contract on the canonical pool/opts and
 * throws on the first violation. The headless harness (_arp_styles_src/verify_all.py
 * + node runner) calls this on each edit.
 */
(function (root) {
  'use strict';

  // ---- bit-exact shared helpers ----
  function mulberry32(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clampInt(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }
  function pmod(a, m) {
    return ((a % m) + m) % m;
  }
  function popcount(x) {
    x = x >>> 0;
    var c = 0;
    while (x) { x &= x - 1; c++; }
    return c;
  }

  var STYLES = {};

  // ===================================================================
  // EUCLIDEAN — Bjorklund maximally-even pulse grids (rhythm-automata)
  //   Bjorklund(k,n) distributes k pulses maximally evenly over n steps.
  //   Rotate left by `rotation`: step i uses pat[(i+rotation)%n]. Tile to length.
  //   1 FIRES -> note (pulse counter p advances only on fires);
  //     idx=pmod(p,L); octShift=clampInt(pmod(floor(p/L),octaves),-(oct-1),oct-1);
  //     vel=(i%n===0)?110:70 (downbeat accent). 0 -> REST.
  //   Known (rot 0): E(3,8)=10010010, E(5,8)=10110110, E(2,5)=10100,
  //                  E(5,16) maximally-even (gaps 3,3,3,3,4).
  // ===================================================================
  function bjorklund(k, n) {
    k = k | 0; n = n | 0;
    if (n <= 0) return [];
    if (k <= 0) { var z = new Array(n); for (var zi = 0; zi < n; zi++) z[zi] = 0; return z; }
    if (k >= n) { var o = new Array(n); for (var oi = 0; oi < n; oi++) o[oi] = 1; return o; }
    var seqs = [], remainder = [];
    for (var gi = 0; gi < k; gi++) seqs.push([1]);
    for (var gj = 0; gj < (n - k); gj++) remainder.push([0]);
    while (remainder.length > 1) {
      var m = Math.min(seqs.length, remainder.length);
      var newSeqs = [];
      for (var i = 0; i < m; i++) newSeqs.push(seqs[i].concat(remainder[i]));
      var newRemainder = (seqs.length > remainder.length) ? seqs.slice(m) : remainder.slice(m);
      seqs = newSeqs;
      remainder = newRemainder;
    }
    var pattern = [], g, c;
    for (g = 0; g < seqs.length; g++) for (c = 0; c < seqs[g].length; c++) pattern.push(seqs[g][c]);
    for (g = 0; g < remainder.length; g++) for (c = 0; c < remainder[g].length; c++) pattern.push(remainder[g][c]);
    return pattern;
  }
  STYLES.euclidean = {
    key: 'euclidean',
    label: 'EUCLIDEAN',
    family: 'rhythm-automata',
    params: [
      { name: 'k', type: 'int', min: 1, max: 16, default: 5, descr: 'pulses (notes that fire)' },
      { name: 'n', type: 'int', min: 2, max: 32, default: 8, descr: 'steps per cycle' },
      { name: 'rotation', type: 'int', min: 0, max: 31, default: 0, descr: 'rotate the pulse grid' }
    ],
    gen: function (pool, opts) {
      var L = Math.max(1, (pool && pool.length) ? pool.length : 1);
      var length = opts.length | 0;
      var octaves = (opts.octaves | 0) || 1;
      if (octaves < 1) octaves = 1;
      var k = (opts.k != null) ? (opts.k | 0) : 5;
      var n = (opts.n != null) ? (opts.n | 0) : 8;
      var rotation = (opts.rotation != null) ? (opts.rotation | 0) : 0;
      if (n < 1) n = 1;
      var octBound = octaves - 1;
      var pat = bjorklund(k, n);
      var steps = new Array(length);
      var p = 0;
      for (var i = 0; i < length; i++) {
        var bit = pat[pmod(i + rotation, n)];
        if (bit === 1) {
          var idx = pmod(p, L);
          var octShift = clampInt(pmod(Math.floor(p / L), octaves), -octBound, octBound);
          var vel = (i % n === 0) ? 110 : 70;
          steps[i] = { idx: idx, octShift: octShift, vel: vel };
          p++;
        } else {
          steps[i] = { idx: null, octShift: 0, vel: 0 };
        }
      }
      return steps;
    }
  };
  // === END EUCLIDEAN ===

  // ===================================================================
  // RECAMAN — OEIS A005132 (number-sequences)
  // ===================================================================
  STYLES.recaman = {
    key: 'recaman',
    label: 'RECAMAN',
    family: 'number-sequences',
    params: [
      { name: 'start', type: 'int', min: 0, max: 4, default: 0, descr: 'Seed a(0) of the sequence' },
      { name: 'rest_on_repeat_dir', type: 'bool', default: false, descr: 'Rest when the subtract branch is blocked' }
    ],
    gen: function (pool, opts) {
      var L = Math.max(1, (pool && pool.length) ? pool.length : 1);
      var length = opts.length | 0;
      var octaves = (opts.octaves != null ? opts.octaves : 1) | 0;
      var start = (opts.start != null ? opts.start : 0) | 0;
      var restOnRepeatDir = !!opts.rest_on_repeat_dir;

      var octBound = Math.max(0, octaves - 1);
      var out = [];
      var seen = Object.create(null);
      var aPrev = null;
      seen[start] = true;

      for (var n = 0; n < length; n++) {
        var cur, blocked, d;
        if (n === 0) {
          cur = start; blocked = false; d = 0;
        } else {
          var candSub = aPrev - n;
          if (candSub > 0 && !seen[candSub]) { cur = candSub; blocked = false; }
          else { cur = aPrev + n; blocked = true; }
          seen[cur] = true;
          d = cur - aPrev;
        }
        var idx = pmod(cur, L);
        var octShift = (n === 0) ? 0 : clampInt(Math.round(d / L), -octBound, octBound);
        var vel = clampInt(70 + pmod(cur, 40), 1, 127);
        if (restOnRepeatDir && blocked) out.push({ idx: null, octShift: 0, vel: vel });
        else out.push({ idx: idx, octShift: octShift, vel: vel });
        aPrev = cur;
      }
      return out;
    }
  };
  // === END RECAMAN ===

  // ===================================================================
  // COLLATZ — hailstone (3n+1) per seed (number-sequences)
  // ===================================================================
  function collatzHailstone(seed) {
    var h = seed | 0;
    if (h < 1) h = 1;
    var traj = [];
    while (h !== 1) {
      traj.push(h);
      h = (h % 2 === 0) ? (h / 2) : (3 * h + 1);
    }
    traj.push(1);
    return traj;
  }
  STYLES.collatz = {
    key: 'collatz',
    label: 'COLLATZ',
    family: 'number-sequences',
    params: [
      { name: 'seed', type: 'int', min: 1, max: 200, default: 27,
        descr: 'Hailstone start; phrase length varies per seed' },
      { name: 'restart_on_one', type: 'bool', default: true,
        descr: 'On reaching 1: wrap the trajectory (on) or rest out the tail (off)' }
    ],
    gen: function (pool, opts) {
      var L = Math.max(1, (pool && pool.length) ? pool.length : 1);
      var length = opts.length | 0;
      var octaves = (opts.octaves != null ? opts.octaves : 1) | 0;
      var seed = (opts.seed != null ? opts.seed : 27) | 0;
      var restart = (opts.restart_on_one != null) ? !!opts.restart_on_one : true;

      var sval = clampInt(seed, 1, 200);
      var traj = collatzHailstone(sval);
      var hi = Math.max(0, octaves - 1);
      var lo = -hi;

      var out = [];
      for (var i = 0; i < length; i++) {
        var h;
        if (i < traj.length) {
          h = traj[i];
        } else if (restart) {
          h = traj[i % traj.length];
        } else {
          out.push({ idx: null, octShift: 0, vel: 1 });
          continue;
        }
        var idx = pmod(h, L);
        var octShift = clampInt((h % 2 === 1) ? 1 : -1, lo, hi);
        var vel = clampInt(60 + pmod(h, 60), 1, 127);
        out.push({ idx: idx, octShift: octShift, vel: vel });
      }
      return out;
    }
  };
  // === END COLLATZ ===

  // ===================================================================
  // LOGISTIC — 1-D logistic map x_{n+1}=r*x*(1-x) (chaos-attractors)
  // From fixed x0, discard SETTLE=200 transient, then one note per iteration.
  // Single double x, bit-identical recurrence to logistic_ref.py.
  // ===================================================================
  STYLES.logistic = {
    key: 'logistic',
    label: 'LOGISTIC',
    family: 'chaos-attractors',
    params: [
      { name: 'r', type: 'float', min: 2.4, max: 4.0, default: 3.9,
        descr: 'Growth rate. ~3.57+ = chaos; lower = locked ostinato. The order->chaos knob.' },
      { name: 'x0', type: 'float', min: 0.01, max: 0.99, default: 0.5,
        descr: 'Initial seed value (avoids absorbing 0 at r=3.9).' },
      { name: 'velMode', type: 'enum', options: ['fromX', 'fixed'], default: 'fromX',
        descr: 'fromX = velocity tracks the orbit; fixed = constant 96.' },
      { name: 'octSpan', type: 'int', min: 0, max: 2, default: 1,
        descr: 'Octave spread driven by x (clamped to engine octave range).' }
    ],
    gen: function (pool, opts) {
      var SETTLE = 200;
      var L = Math.max(1, (pool && pool.length) ? pool.length : 1);
      var length = opts.length | 0;
      var octaves = (opts.octaves != null ? opts.octaves : 1) | 0;
      var r = +(opts.r != null ? opts.r : 3.9);
      var x0 = +(opts.x0 != null ? opts.x0 : 0.5);
      var velMode = opts.velMode != null ? opts.velMode : 'fromX';
      var octSpan = (opts.octSpan != null ? opts.octSpan : 1) | 0;

      var octBound = Math.max(0, octaves - 1);
      var out = new Array(length);
      var x = x0, i;
      for (i = 0; i < SETTLE; i++) { x = r * x * (1.0 - x); }
      for (i = 0; i < length; i++) {
        x = r * x * (1.0 - x);
        var xc = x;
        if (xc < 0.0) xc = 0.0; else if (xc > 1.0) xc = 1.0;
        var idx = clampInt(Math.floor(xc * L), 0, L - 1);
        var octShift = clampInt(Math.floor(xc * (2 * octSpan + 1)) - octSpan, -octBound, octBound);
        var vel = (velMode === 'fromX') ? clampInt(40 + Math.floor(xc * 87), 1, 127) : 96;
        out[i] = { idx: idx, octShift: octShift, vel: vel };
      }
      return out;
    }
  };
  // === END LOGISTIC ===

  // ===================================================================
  // PINK 1/F — Voss-McCartney 1/f pink noise (stochastic-structured)
  // ===================================================================
  function pinkTrailingZeros(n) {
    if (n === 0) return 0;
    var t = 0;
    while ((n & 1) === 0) { n >>>= 1; t++; }
    return t;
  }
  STYLES.pink = {
    key: 'pink',
    label: 'PINK 1/F',
    family: 'stochastic-structured',
    params: [
      { name: 'octaves', uiLabel: 'sources (K)', type: 'int', min: 2, max: 8, default: 5, descr: 'K = # summed 1/f noise sources (noise color, NOT register; also octShift bound)' },
      { name: 'seed', type: 'int', min: 0, max: 2147483647, default: 1, descr: 'deterministic seed' },
      { name: 'restProb', type: 'float', min: 0, max: 0.4, default: 0, descr: 'probability a step is a rest' },
      { name: 'hi', type: 'float', min: 0.5, max: 1, default: 0.88, descr: 'p above this -> octave up' },
      { name: 'lo', type: 'float', min: 0, max: 0.5, default: 0.12, descr: 'p below this -> octave down' }
    ],
    gen: function (pool, opts) {
      var L = Math.max(1, (pool && pool.length) ? pool.length : 1);
      var length = opts.length | 0;
      var seed = (opts.seed != null ? opts.seed : 1) | 0;
      var octaves = (opts.octaves != null ? opts.octaves : 5) | 0;
      var K = octaves; // octaves param == K (# summed sources)
      var restProb = (opts.restProb != null ? +opts.restProb : 0);
      var hi = (opts.hi != null ? +opts.hi : 0.88);
      var lo = (opts.lo != null ? +opts.lo : 0.12);

      var rng = mulberry32(seed);
      var octBound = Math.max(0, octaves - 1);

      var rows = new Array(K);
      for (var r = 0; r < K; r++) rows[r] = 0.0;

      var out = new Array(length);
      var pprev = null;

      for (var n = 0; n < length; n++) {
        if (n === 0) {
          for (var i = 0; i < K; i++) rows[i] = rng();
        } else {
          var tz = pinkTrailingZeros(n);
          var top = Math.min(tz, K - 1);
          for (var kk = 0; kk <= top; kk++) rows[kk] = rng();
        }
        var sum = 0.0;
        for (var m = 0; m < K; m++) sum += rows[m];
        var jit = rng();
        var p = (sum + jit) / (K + 1);

        if (pprev === null) pprev = p;

        var idx = pmod(Math.floor(p * L), L);
        var octShift;
        if (p > hi) octShift = 1;
        else if (p < lo) octShift = -1;
        else octShift = 0;
        octShift = clampInt(octShift, -octBound, octBound);

        var dd = Math.abs(p - pprev);
        var vel = clampInt(Math.round(48 + 79 * (0.35 * p + 0.65 * Math.min(1.0, dd * 4.0))), 1, 127);

        var isRest = false;
        if (restProb > 0.0) {
          var rr = rng();
          if (rr < restProb) isRest = true;
        }

        if (isRest) out[n] = { idx: null, octShift: 0, vel: 0 };
        else out[n] = { idx: idx, octShift: octShift, vel: vel };

        pprev = p;
      }
      return out;
    }
  };
  // === END PINK 1/F ===

  // ===================================================================
  // GOLDEN — phyllotaxis index (number-sequences)
  //   phi = (1 + Math.sqrt(5)) / 2 ; g(n) = floor((n + offset) * phi)
  //   idx = pmod(g, L); octShift via pmod(floor(g/L), octaves);
  //   vel = clampInt(64 + pmod(g,50),1,127); no rests (maximally even).
  // ===================================================================
  STYLES.golden = {
    key: 'golden',
    label: 'GOLDEN',
    family: 'number-sequences',
    params: [
      { name: 'offset', type: 'int', min: 0, max: 50, default: 0, descr: 'Phyllotaxis start index — rotates the spiral.' },
      { name: 'wrap_octaves', type: 'bool', default: true, descr: 'Let the spiral climb octaves as the index wraps the pool.' }
    ],
    gen: function (pool, opts) {
      var L = Math.max(1, (pool && pool.length) ? pool.length : 1);
      var length = opts.length | 0;
      var octaves = (opts.octaves != null ? opts.octaves : 1) | 0;
      var offset = (opts.offset != null ? opts.offset : 0) | 0;
      var wrap = (opts.wrap_octaves === undefined) ? true : !!opts.wrap_octaves;

      var phi = (1 + Math.sqrt(5)) / 2;
      var octBound = Math.max(0, octaves - 1);
      var out = new Array(length);
      for (var n = 0; n < length; n++) {
        var g = Math.floor((n + offset) * phi);
        var idx = pmod(g, L);
        var octShift = 0;
        if (wrap && octaves > 1) {
          octShift = clampInt(pmod(Math.floor(g / L), octaves), -octBound, octBound);
        }
        var vel = clampInt(64 + pmod(g, 50), 1, 127);
        out[n] = { idx: idx, octShift: octShift, vel: vel };
      }
      return out;
    }
  };
  // === END GOLDEN ===

  // ===================================================================
  // AUTOMATON — elementary cellular automaton (rhythm-automata)
  // ECA, width-w binary row, periodic (wrap) boundaries:
  //   next[i] = (rule >> ((Ln<<2)|(C<<1)|Rn)) & 1
  // One generation = one emitted step; advance AFTER emitting.
  // Mapping per generation on the CURRENT row:
  //   cnt=popcount(row); cnt===0 -> REST + reseed centre (keep-alive, no advance)
  //   else idx=pmod(cnt,L); octShift=clampInt(pmod(popcount(leftHalf),octaves),-(oct-1),oct-1);
  //        vel=clampInt(50 + (row[w>>1]?50:0) + min(54,cnt*2), 1, 127)
  // leftHalf = cells strictly left of centre: indices 0..(w>>1)-1.
  // Bit-identical to _arp_styles_src/automaton_ref.py (KEPLER-verified).
  // ===================================================================
  function caPopcountRange(arr, lo, hi) {
    var c = 0;
    for (var i = lo; i < hi; i++) c += arr[i] ? 1 : 0;
    return c;
  }
  STYLES.automaton = {
    key: 'automaton',
    label: 'AUTOMATON',
    family: 'rhythm-automata',
    params: [
      { name: 'rule', type: 'int', min: 0, max: 255, default: 90,
        descr: 'Wolfram rule number (presets 30 chaotic \u00b7 90 Sierpinski \u00b7 110 complex)' },
      { name: 'width', type: 'int', min: 5, max: 63, default: 31,
        descr: 'CA row width in cells (odd preferred)' },
      { name: 'seedMode', type: 'enum', options: ['center', 'random'], default: 'center',
        descr: 'center = single live centre cell \u00b7 random = seeded mulberry32 fill' }
    ],
    gen: function (pool, opts) {
      var L = Math.max(1, (pool && pool.length) ? pool.length : 1);
      var N = opts.length | 0;
      var octaves = Math.max(1, (opts.octaves != null ? opts.octaves : 1) | 0);
      var rule = clampInt((opts.rule != null ? opts.rule : 90) | 0, 0, 255);
      var w = clampInt((opts.width != null ? opts.width : 31) | 0, 5, 63);
      var seedMode = (opts.seedMode === 'random') ? 'random' : 'center';
      var centre = w >> 1;

      var row = new Array(w);
      var i, j;
      if (seedMode === 'random') {
        var rng = mulberry32((opts.seed != null ? opts.seed : 1) | 0);
        for (i = 0; i < w; i++) row[i] = (rng() < 0.5) ? 1 : 0;
      } else {
        for (j = 0; j < w; j++) row[j] = 0;
        row[centre] = 1;
      }

      var out = new Array(N);
      for (var step = 0; step < N; step++) {
        var cnt = caPopcountRange(row, 0, w);
        if (cnt === 0) {
          out[step] = { idx: null, octShift: 0, vel: 0 };
          row[centre] = 1; // keep-alive reseed, do NOT advance this step
          continue;
        }
        var leftCnt = caPopcountRange(row, 0, centre); // strictly left of centre
        var idx = pmod(cnt, L);
        var octShift = clampInt(pmod(leftCnt, octaves), -(octaves - 1), octaves - 1);
        var vel = clampInt(50 + (row[centre] ? 50 : 0) + Math.min(54, cnt * 2), 1, 127);
        out[step] = { idx: idx, octShift: octShift, vel: vel };

        var next = new Array(w);
        for (var c = 0; c < w; c++) {
          var nb = (row[(c - 1 + w) % w] << 2) | (row[c] << 1) | row[(c + 1) % w];
          next[c] = (rule >> nb) & 1;
        }
        row = next;
      }
      return out;
    }
  };
  // === END AUTOMATON ===

  // ===================================================================
  // LORENZ DRIFT — KEPLER strange-attractor melody (chaos-attractors)
  // Field bodies = EXACT KEPLER structures.field_js (params baked).
  // Scalar RK4 = integrate._rk4_traj_inc ported to length-3 doubles with
  // IDENTICAL op order to lorenz_ref.py (byte-identical JS<->Python).
  // benettin('lorenz') lambda1~=0.906>0 => genuinely aperiodic.
  //   one coord -> scale degree (idx), another -> octave, another -> velocity.
  // ===================================================================
  var LORENZ_SPAWN_CENTER = {
    lorenz:  [0.0, 0.0, 25.0],
    thomas:  [0.0, 0.0, 0.0],
    rossler: [2.0, 2.0, 0.0]
  };
  var LORENZ_BOUNDS = {
    lorenz:  { x: [-15.649254, 15.653349], y: [-19.919808, 19.913585], z: [7.362228, 41.348081] },
    thomas:  { x: [-0.973582, 3.745618],  y: [-0.967837, 3.742653],   z: [-0.979606, 3.738019] },
    rossler: { x: [-8.785913, 10.889501], y: [-10.412741, 7.563634],  z: [0.013828, 16.847626] }
  };
  var LORENZ_SETTLE = 500;
  function lorenzField(name, x, y, z) {
    if (name === 'lorenz') {
      return [10.0 * (y - x),
              x * (28.0 - z) - y,
              x * y - (8.0 / 3.0) * z];
    }
    if (name === 'thomas') {
      var b = 0.208186;
      return [Math.sin(y) - b * x,
              Math.sin(z) - b * y,
              Math.sin(x) - b * z];
    }
    return [-y - z,
            x + 0.2 * y,
            0.2 + z * (x - 5.7)];
  }
  function lorenzRk4inc(name, p, h) {
    var x = p[0], y = p[1], z = p[2];
    var k1 = lorenzField(name, x, y, z);
    var k2 = lorenzField(name, x + 0.5 * h * k1[0], y + 0.5 * h * k1[1], z + 0.5 * h * k1[2]);
    var k3 = lorenzField(name, x + 0.5 * h * k2[0], y + 0.5 * h * k2[1], z + 0.5 * h * k2[2]);
    var k4 = lorenzField(name, x + h * k3[0], y + h * k3[1], z + h * k3[2]);
    return [k1[0] + 2.0 * k2[0] + 2.0 * k3[0] + k4[0],
            k1[1] + 2.0 * k2[1] + 2.0 * k3[1] + k4[1],
            k1[2] + 2.0 * k2[2] + 2.0 * k3[2] + k4[2]];
  }
  function lorenzStep(name, p, h) {
    var inc = lorenzRk4inc(name, p, h);
    return [p[0] + (h / 6.0) * inc[0],
            p[1] + (h / 6.0) * inc[1],
            p[2] + (h / 6.0) * inc[2]];
  }
  function lorenzClamp01(v) { return v < 0.0 ? 0.0 : (v > 1.0 ? 1.0 : v); }
  function lorenzNorm(v, lo, hi) { return lorenzClamp01((v - lo) / (hi - lo)); }
  STYLES.lorenz = {
    key: 'lorenz',
    label: 'LORENZ DRIFT',
    family: 'chaos-attractors',
    params: [
      { name: 'attractor', type: 'enum', options: ['lorenz', 'thomas', 'rossler'],
        default: 'lorenz', descr: 'Strange attractor orbit (KEPLER-verified)' },
      { name: 'dt', type: 'float', min: 0.001, max: 0.05, default: 0.01,
        descr: 'RK4 integration step — smaller = slower drift' },
      { name: 'speed', type: 'int', min: 1, max: 8, default: 2,
        descr: 'RK4 steps advanced per emitted note' }
    ],
    gen: function (pool, opts) {
      var L = Math.max(1, (pool && pool.length) ? pool.length : 1);
      var length = opts.length | 0;
      var octaves = Math.max(1, (opts.octaves != null ? opts.octaves : 1) | 0);
      var name = opts.attractor || 'lorenz';
      var dt = +opts.dt;
      if (!isFinite(dt)) dt = 0.01;
      var speed = Math.max(1, (opts.speed != null ? opts.speed : 2) | 0);

      var c = LORENZ_SPAWN_CENTER[name];
      var b = LORENZ_BOUNDS[name];
      var p = [c[0] + 0.1, c[1], c[2]];

      var i, s;
      for (i = 0; i < LORENZ_SETTLE; i++) p = lorenzStep(name, p, dt);

      var halfOct = Math.floor(octaves / 2);
      var out = new Array(length);
      for (i = 0; i < length; i++) {
        for (s = 0; s < speed; s++) p = lorenzStep(name, p, dt);
        var nx = lorenzNorm(p[0], b.x[0], b.x[1]);
        var ny = lorenzNorm(p[1], b.y[0], b.y[1]);
        var nz = lorenzNorm(p[2], b.z[0], b.z[1]);
        var idx = clampInt(Math.floor(nx * L), 0, L - 1);
        var octShift = clampInt(Math.floor(nz * octaves) - halfOct, -(octaves - 1), octaves - 1);
        var vel = clampInt(40 + Math.floor(ny * 87.0), 1, 127);
        out[i] = { idx: idx, octShift: octShift, vel: vel };
      }
      return out;
    }
  };
  // === END LORENZ DRIFT ===

  // ===================================================================
  // THUE-MORSE — self-similar parity sequence (number-sequences)
  //   t(n) = popcount(n) & 1 (cube-free, fractal self-similarity).
  //   running pointer p over pool, oct counter:
  //     t==0 -> p+=step ; t==1 -> p-=step
  //     n>0 & t!=t(n-1) & flip_octave -> oct = pmod(oct+1, octaves)
  //   idx=pmod(p,L); octShift=clampInt(oct,-(oct-1),oct-1); vel=t?100:72
  //   rest_bit: 'zero'->rest when t==0; 'one'->t==1; 'none'->no rests.
  // Bit-identical to _arp_styles_src/thuemorse_ref.py.
  // ===================================================================
  function tmParity(n) { return popcount(n) & 1; }
  STYLES.thuemorse = {
    key: 'thuemorse',
    label: 'THUE-MORSE',
    family: 'number-sequences',
    params: [
      { name: 'step', type: 'int', min: 1, max: 4, default: 1, descr: 'Pointer move per bit (pool steps)' },
      { name: 'flip_octave', type: 'bool', default: true, descr: 'Advance octave on parity changes' },
      { name: 'rest_bit', type: 'enum', options: ['none', 'zero', 'one'], default: 'none', descr: 'Which parity bit becomes a rest' }
    ],
    gen: function (pool, opts) {
      var L = Math.max(1, (pool && pool.length) ? pool.length : 1);
      var length = opts.length | 0;
      var octaves = (opts.octaves | 0) || 1;
      if (octaves < 1) octaves = 1;
      var step = (opts.step == null) ? 1 : (opts.step | 0);
      var flipOct = (opts.flip_octave == null) ? true : !!opts.flip_octave;
      var restBit = (opts.rest_bit == null) ? 'none' : opts.rest_bit;

      var out = new Array(length);
      var p = 0;
      var oct = 0;
      var prev = -1;
      for (var n = 0; n < length; n++) {
        var t = tmParity(n);
        if (t === 0) p += step; else p -= step;
        if (n > 0 && t !== prev && flipOct) {
          oct = pmod(oct + 1, octaves);
        }
        var isRest = (restBit === 'zero' && t === 0) || (restBit === 'one' && t === 1);
        if (isRest) {
          out[n] = { idx: null, octShift: 0, vel: 1 };
        } else {
          out[n] = {
            idx: pmod(p, L),
            octShift: clampInt(oct, -(octaves - 1), octaves - 1),
            vel: t ? 100 : 72
          };
        }
        prev = t;
      }
      return out;
    }
  };
  // === END THUE-MORSE ===

  // ---- self-test (StepObject contract assertion for CI / node harness) ----
  // Runs every registered gen against the contract on the canonical pool/opts.
  // Returns { ok:true } or throws an Error naming the first violating style/step.
  function _selfTest(opts) {
    opts = opts || {};
    var pool = opts.pool || [60, 62, 64, 67, 69];
    var L = pool.length;
    var base = { length: (opts.length | 0) || 64, seed: (opts.seed != null ? opts.seed : 1994) | 0, octaves: (opts.octaves | 0) || 3 };
    var octBound = base.octaves - 1;
    for (var key in STYLES) {
      if (!Object.prototype.hasOwnProperty.call(STYLES, key)) continue;
      var st = STYLES[key];
      if (st.key !== key) throw new Error('selfTest[' + key + ']: key mismatch (st.key=' + st.key + ')');
      var prog = st.gen(pool, base);
      if (!Array.isArray(prog)) throw new Error('selfTest[' + key + ']: gen did not return an Array');
      if (prog.length !== base.length) throw new Error('selfTest[' + key + ']: length ' + prog.length + ' != ' + base.length);
      for (var i = 0; i < prog.length; i++) {
        var s = prog[i];
        if (!s || typeof s !== 'object') throw new Error('selfTest[' + key + '] step ' + i + ': not an object');
        if (!('idx' in s) || !('octShift' in s) || !('vel' in s)) throw new Error('selfTest[' + key + '] step ' + i + ': missing field');
        if (s.idx === null) continue; // REST: octShift/vel ignored per contract
        if (!Number.isInteger(s.idx) || s.idx < 0 || s.idx >= L) throw new Error('selfTest[' + key + '] step ' + i + ': idx ' + s.idx + ' out of [0,' + (L - 1) + ']');
        if (!Number.isInteger(s.octShift) || s.octShift < -octBound || s.octShift > octBound) throw new Error('selfTest[' + key + '] step ' + i + ': octShift ' + s.octShift + ' out of +/-' + octBound);
        if (!Number.isInteger(s.vel) || s.vel < 1 || s.vel > 127) throw new Error('selfTest[' + key + '] step ' + i + ': vel ' + s.vel + ' out of [1,127]');
      }
    }
    return { ok: true, styles: Object.keys(STYLES).length };
  }

  // ---- expose ----
  if (root) {
    root.ARP_STYLES = root.ARP_STYLES || {};
    for (var k in STYLES) { if (Object.prototype.hasOwnProperty.call(STYLES, k)) root.ARP_STYLES[k] = STYLES[k]; }
    root.ARP_STYLES_API = {
      STYLES: STYLES,
      mulberry32: mulberry32,
      clampInt: clampInt,
      pmod: pmod,
      popcount: popcount,
      keys: function () { return Object.keys(root.ARP_STYLES); },
      _selfTest: _selfTest
    };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { STYLES: STYLES, mulberry32: mulberry32, clampInt: clampInt, pmod: pmod, popcount: popcount, _selfTest: _selfTest };
  }
})(typeof window !== 'undefined' ? window : null);
