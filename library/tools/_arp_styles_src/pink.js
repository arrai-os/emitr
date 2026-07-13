/* PINK 1/F — verified arp style (Voss-McCartney 1/f pink noise -> note program).
 *
 * Contract: gen(pool, opts) -> Array<{idx,octShift,vel}> of length opts.length.
 * Deterministic: pure function of (pool.length, opts). All randomness via bit-exact mulberry32.
 * Byte-identical to _arp_styles_src/pink_ref.py for the same inputs.
 *
 * Registers onto window.ARP_STYLES (browser) and is require()-able in Node (window guarded).
 */
(function (root) {
  // ---- bit-exact mulberry32 PRNG (matches Python &0xFFFFFFFF mirror) ----
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
    v = v | 0;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function pmod(a, n) {
    return ((a % n) + n) % n;
  }

  function trailingZeros(n) {
    if (n === 0) return 0;
    var t = 0;
    while ((n & 1) === 0) { n >>>= 1; t++; }
    return t;
  }

  var style = {
    key: 'pink',
    label: 'PINK 1/F',
    family: 'stochastic-structured',
    params: [
      { name: 'octaves', type: 'int', min: 2, max: 8, default: 5,
        descr: 'K = # summed 1/f sources (also octShift bound)' },
      { name: 'seed', type: 'int', min: 0, max: 2147483647, default: 1,
        descr: 'deterministic seed' },
      { name: 'restProb', type: 'float', min: 0, max: 0.4, default: 0,
        descr: 'probability a step is a rest' },
      { name: 'hi', type: 'float', min: 0.5, max: 1, default: 0.88,
        descr: 'p above this -> octave up' },
      { name: 'lo', type: 'float', min: 0, max: 0.5, default: 0.12,
        descr: 'p below this -> octave down' }
    ],
    gen: function (pool, opts) {
      var L = pool.length | 0;
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
          var tz = trailingZeros(n);
          var top = Math.min(tz, K - 1);
          for (var k = 0; k <= top; k++) rows[k] = rng();
        }
        // sum rows left-to-right starting from 0.0 (matches Python sum())
        var sum = 0.0;
        for (var m = 0; m < K; m++) sum += rows[m];
        var j = rng();
        var p = (sum + j) / (K + 1);

        if (pprev === null) pprev = p;

        var idx = pmod(Math.floor(p * L), L);
        var octShift;
        if (p > hi) octShift = 1;
        else if (p < lo) octShift = -1;
        else octShift = 0;
        octShift = clampInt(octShift, -octBound, octBound);

        var d = Math.abs(p - pprev);
        var vel = clampInt(Math.round(48 + 79 * (0.35 * p + 0.65 * Math.min(1.0, d * 4.0))), 1, 127);

        var isRest = false;
        if (restProb > 0.0) {
          var rr = rng();
          if (rr < restProb) isRest = true;
        }

        if (isRest) {
          out[n] = { idx: null, octShift: 0, vel: 0 };
        } else {
          out[n] = { idx: idx, octShift: octShift, vel: vel };
        }

        pprev = p;
      }
      return out;
    }
  };

  if (root) {
    root.ARP_STYLES = root.ARP_STYLES || {};
    root.ARP_STYLES['pink'] = style;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { style: style, mulberry32: mulberry32, clampInt: clampInt, pmod: pmod };
  }
})(typeof window !== 'undefined' ? window : null);
