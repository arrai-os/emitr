/* GOLDEN arp style — JS generator (number-sequences family).
 *
 * Phyllotaxis index. phi = (1 + Math.sqrt(5)) / 2.
 * g(n) = Math.floor((n + offset) * phi)
 *
 * Mapping (LOCKED, mirrors golden_ref.py bit-for-bit):
 *   idx      = pmod(g(n), L)
 *   octShift = wrap_octaves ? clampInt(pmod(Math.floor(g(n)/L), octaves), -(octaves-1), octaves-1) : 0
 *   vel      = clampInt(64 + pmod(g(n), 50), 1, 127)   // 64..113
 *   no rests (maximally even, dense).
 *
 * Math.sqrt(5) + Math.floor are IEEE-754 identical to Python math.sqrt(5)/math.floor.
 * Deterministic: pure function of (pool.length, opts).
 *
 * Registers onto window.ARP_STYLES (browser) and module.exports (Node).
 */
(function (root) {
  'use strict';

  var PHI = (1 + Math.sqrt(5)) / 2;

  function pmod(a, n) { return ((a % n) + n) % n; }
  function clampInt(v, lo, hi) {
    v = v | 0;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  var style = {
    key: 'golden',
    label: 'GOLDEN',
    family: 'number-sequences',
    params: [
      { name: 'offset', type: 'int', min: 0, max: 50, default: 0,
        descr: 'Phyllotaxis start index — rotates the spiral.' },
      { name: 'wrap_octaves', type: 'bool', default: true,
        descr: 'Let the spiral climb octaves as the index wraps the pool.' }
    ],
    gen: function (pool, opts) {
      var L = pool.length;
      var length = opts.length | 0;
      var octaves = (opts.octaves | 0) || 1;
      var offset = (opts.offset | 0) || 0;
      var wrap = (opts.wrap_octaves === undefined) ? true : !!opts.wrap_octaves;

      var out = new Array(length);
      for (var n = 0; n < length; n++) {
        var g = Math.floor((n + offset) * PHI);
        var idx = pmod(g, L);
        var octShift = 0;
        if (wrap && octaves > 1) {
          var octRaw = pmod(Math.floor(g / L), octaves);
          octShift = clampInt(octRaw, -(octaves - 1), octaves - 1);
        }
        var vel = clampInt(64 + pmod(g, 50), 1, 127);
        out[n] = { idx: idx, octShift: octShift, vel: vel };
      }
      return out;
    }
  };

  if (root) {
    root.ARP_STYLES = root.ARP_STYLES || {};
    root.ARP_STYLES['golden'] = style;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = style;
  }
})(typeof window !== 'undefined' ? window : null);
