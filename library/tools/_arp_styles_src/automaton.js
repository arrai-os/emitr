/* ARP MATH STYLE — automaton (AUTOMATON) · family rhythm-automata
 * Elementary cellular automaton (Wolfram). width-w binary row, periodic (wrap) boundaries.
 * Next cell i: (rule >> ((Ln<<2)|(C<<1)|Rn)) & 1.  One generation = one step; advance AFTER emitting.
 * Mapping per generation on the CURRENT row:
 *   cnt = popcount(row)
 *   cnt===0  -> REST {idx:null,octShift:0,vel:0}, then reseed centre cell (deterministic keep-alive)
 *   else     -> idx=pmod(cnt,L); octShift=clampInt(pmod(popcount(leftHalf),octaves),-(octaves-1),octaves-1);
 *               vel=clampInt(50 + (row[w>>1]?50:0) + Math.min(54,cnt*2), 1, 127)
 * leftHalf = cells strictly left of centre: indices 0 .. (w>>1)-1.
 * DETERMINISTIC: pure function of (pool.length, opts). seedMode='random' uses shared mulberry32(opts.seed).
 * Self-registers onto window.ARP_STYLES['automaton']; also require()-able under Node (window guarded).
 */
(function (root) {
  'use strict';

  // shared mulberry32 (bit-exact with Python ref) — local copy so this file is standalone in Node tests
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
  function clampInt(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function pmod(a, m) { return ((a % m) + m) % m; }

  function popcount(arr, lo, hi) {
    var c = 0;
    for (var i = lo; i < hi; i++) c += arr[i] ? 1 : 0;
    return c;
  }

  function gen(pool, opts) {
    var L = Math.max(1, pool.length | 0);
    var N = opts.length | 0;
    var octaves = Math.max(1, opts.octaves | 0);

    var rule = clampInt(opts.rule | 0, 0, 255);
    var w = clampInt(opts.width | 0, 5, 63);
    var seedMode = (opts.seedMode === 'random') ? 'random' : 'center';
    var centre = w >> 1;

    // seed row
    var row = new Array(w);
    if (seedMode === 'random') {
      var rng = mulberry32(opts.seed | 0);
      for (var i = 0; i < w; i++) row[i] = (rng() < 0.5) ? 1 : 0;
    } else {
      for (var j = 0; j < w; j++) row[j] = 0;
      row[centre] = 1;
    }

    var out = new Array(N);
    for (var step = 0; step < N; step++) {
      var cnt = popcount(row, 0, w);

      if (cnt === 0) {
        out[step] = { idx: null, octShift: 0, vel: 0 };
        // deterministic keep-alive: reseed centre, do NOT advance the CA this step
        row[centre] = 1;
        continue;
      }

      var leftCnt = popcount(row, 0, centre);           // cells strictly left of centre
      var idx = pmod(cnt, L);
      var octShift = clampInt(pmod(leftCnt, octaves), -(octaves - 1), octaves - 1);
      var vel = clampInt(50 + (row[centre] ? 50 : 0) + Math.min(54, cnt * 2), 1, 127);
      out[step] = { idx: idx, octShift: octShift, vel: vel };

      // advance one generation (periodic boundaries)
      var next = new Array(w);
      for (var c = 0; c < w; c++) {
        var Ln = row[(c - 1 + w) % w];
        var C = row[c];
        var Rn = row[(c + 1) % w];
        var nb = (Ln << 2) | (C << 1) | Rn;
        next[c] = (rule >> nb) & 1;
      }
      row = next;
    }
    return out;
  }

  var style = {
    key: 'automaton',
    label: 'AUTOMATON',
    family: 'rhythm-automata',
    params: [
      { name: 'rule', type: 'int', min: 0, max: 255, default: 90,
        descr: 'Wolfram rule number (presets 30 chaotic · 90 Sierpinski · 110 complex)' },
      { name: 'width', type: 'int', min: 5, max: 63, default: 31,
        descr: 'CA row width in cells (odd preferred)' },
      { name: 'seedMode', type: 'enum', options: ['center', 'random'], default: 'center',
        descr: 'center = single live centre cell · random = seeded mulberry32 fill' }
    ],
    gen: gen
  };

  if (root) {
    root.ARP_STYLES = root.ARP_STYLES || {};
    root.ARP_STYLES['automaton'] = style;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = style;
  }
})(typeof window !== 'undefined' ? window : null);
