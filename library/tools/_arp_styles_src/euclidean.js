/*
 * EUCLIDEAN arp style — JS generator (KEPLER-verified provenance).
 *
 * Contract (LOCKED):
 *   gen(pool, opts) -> Array<{idx:int|null, octShift:int, vel:int}> of length opts.length
 *   Deterministic pure function of (pool.length, opts).
 *
 * Math: Bjorklund(k,n) distributes k pulses maximally evenly over n steps.
 *   Rotate left by `rotation`: pat[(i+rotation)%n]. Tile: step i uses pat[i%n].
 * Mapping: 1 FIRES -> note; 0 -> REST(idx=null). Pulse counter p advances only on fires.
 *   On fire: idx=pmod(p,L); octShift=clampInt(pmod(floor(p/L),octaves),-(octaves-1),octaves-1);
 *            vel=(i%n===0)?110:70; p++. On rest: {idx:null,octShift:0,vel:0}.
 * Params: k(int 1-16 def 5); n(int 2-32 def 8); rotation(int 0-31 def 0).
 */
(function (root) {
  function pmod(a, m) { return ((a % m) + m) % m; }
  function clampInt(v, lo, hi) {
    v = Math.floor(v);
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  // Classic Bjorklund: maximally-even k pulses over n steps -> array of n bits.
  function bjorklund(k, n) {
    k = k | 0; n = n | 0;
    if (n <= 0) return [];
    if (k <= 0) return new Array(n).fill(0);
    if (k >= n) return new Array(n).fill(1);

    // Canonical Bjorklund fold (mirrors euclidean_ref.py exactly).
    var seqs = [];
    var remainder = [];
    for (var gi = 0; gi < k; gi++) seqs.push([1]);
    for (var gj = 0; gj < (n - k); gj++) remainder.push([0]);

    while (remainder.length > 1) {
      var m = Math.min(seqs.length, remainder.length);
      var newSeqs = [];
      for (var i = 0; i < m; i++) newSeqs.push(seqs[i].concat(remainder[i]));
      var newRemainder;
      if (seqs.length > remainder.length) {
        newRemainder = seqs.slice(m);
      } else {
        newRemainder = remainder.slice(m);
      }
      seqs = newSeqs;
      remainder = newRemainder;
    }

    var pattern = [];
    var g, c;
    for (g = 0; g < seqs.length; g++) {
      for (c = 0; c < seqs[g].length; c++) pattern.push(seqs[g][c]);
    }
    for (g = 0; g < remainder.length; g++) {
      for (c = 0; c < remainder[g].length; c++) pattern.push(remainder[g][c]);
    }
    return pattern;
  }

  function gen(pool, opts) {
    var L = Math.max(1, (pool && pool.length) ? pool.length : 1);
    var length = opts.length | 0;
    var octaves = (opts.octaves | 0) || 1;
    if (octaves < 1) octaves = 1;

    var k = (opts.k != null) ? (opts.k | 0) : 5;
    var n = (opts.n != null) ? (opts.n | 0) : 8;
    var rotation = (opts.rotation != null) ? (opts.rotation | 0) : 0;
    if (n < 1) n = 1;

    var pat = bjorklund(k, n);

    var steps = new Array(length);
    var p = 0;
    for (var i = 0; i < length; i++) {
      var bit = pat[pmod(i + rotation, n)];
      if (bit === 1) {
        var idx = pmod(p, L);
        var octShift = clampInt(pmod(Math.floor(p / L), octaves), -(octaves - 1), octaves - 1);
        var vel = (i % n === 0) ? 110 : 70;
        steps[i] = { idx: idx, octShift: octShift, vel: vel };
        p++;
      } else {
        steps[i] = { idx: null, octShift: 0, vel: 0 };
      }
    }
    return steps;
  }

  var STYLE = {
    key: 'euclidean',
    label: 'EUCLIDEAN',
    family: 'rhythm-automata',
    params: [
      { name: 'k', type: 'int', min: 1, max: 16, default: 5, descr: 'pulses (notes that fire)' },
      { name: 'n', type: 'int', min: 2, max: 32, default: 8, descr: 'steps per cycle' },
      { name: 'rotation', type: 'int', min: 0, max: 31, default: 0, descr: 'rotate the pulse grid' }
    ],
    gen: gen
  };

  if (root) {
    root.ARP_STYLES = root.ARP_STYLES || {};
    root.ARP_STYLES['euclidean'] = STYLE;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { STYLE: STYLE, gen: gen, bjorklund: bjorklund, pmod: pmod, clampInt: clampInt };
  }
})(typeof window !== 'undefined' ? window : null);
