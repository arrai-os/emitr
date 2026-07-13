// THUE-MORSE arp style — per-style verified source (provenance).
// Contract: registers window.ARP_STYLES['thuemorse'] = { key,label,family,params,gen(pool,opts) }.
// Deterministic, require()-able in Node (window-guarded). No randomness needed (pure parity sequence).
//
// MATH: t(n) = popcount(n) & 1  (parity of set bits, Kernighan loop). Self-similar, cube-free.
// MAPPING:
//   running pointer p (start 0) over pool, oct (start 0).
//   t(n)==0 -> p += step ;  t(n)==1 -> p -= step
//   if n>0 and t(n)!=t(n-1) and flip_octave -> oct = pmod(oct+1, octaves)
//   idx      = pmod(p, L)
//   octShift = clampInt(oct, -(octaves-1), octaves-1)
//   vel      = t(n) ? 100 : 72
//   rests via rest_bit: 'zero' -> idx=null when t(n)==0; 'one' -> when t(n)==1; 'none' -> no rests
(function (root) {
  'use strict';

  function pmod(a, n) { return ((a % n) + n) % n; }
  function clampInt(v, lo, hi) {
    v = v | 0;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }
  // popcount via Kernighan loop (bit-exact w/ Python ref)
  function popcount(x) {
    x = x >>> 0;
    var c = 0;
    while (x) { x &= (x - 1) >>> 0; c++; }
    return c;
  }
  function tm(n) { return popcount(n) & 1; }

  var style = {
    key: 'thuemorse',
    label: 'THUE-MORSE',
    family: 'number-sequences',
    params: [
      { name: 'step', type: 'int', min: 1, max: 4, default: 1, descr: 'Pointer move per bit (pool steps)' },
      { name: 'flip_octave', type: 'bool', default: true, descr: 'Advance octave on parity changes' },
      { name: 'rest_bit', type: 'enum', options: ['none', 'zero', 'one'], default: 'none', descr: 'Which parity bit becomes a rest' }
    ],
    gen: function (pool, opts) {
      var L = (pool && pool.length) ? pool.length : 1;
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
        var t = tm(n);
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

  if (root) {
    root.ARP_STYLES = root.ARP_STYLES || {};
    root.ARP_STYLES['thuemorse'] = style;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = style;
  }
})(typeof window !== 'undefined' ? window : null);
