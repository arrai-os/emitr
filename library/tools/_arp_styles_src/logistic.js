/* LOGISTIC arp style — JS generator (KEPLER-verified).
 *
 * 1-D logistic map  x_{n+1} = r * x_n * (1 - x_n).
 * From fixed x0, discard SETTLE=200 transient iterations, then emit one note
 * per iteration. Single double `x`, identical recurrence to logistic_ref.py.
 *
 * Contract (LOCKED): gen(pool, opts) -> Array<{idx,octShift,vel}> length opts.length.
 *   pool  = ascending Array<int> MIDI pitches (only pool.length used here).
 *   opts  = { length, seed, octaves, r, x0, velMode, octSpan }.
 * Deterministic: pure function of (pool.length, opts). Never returns a rest.
 *
 * Loadable via <script src> (window) AND require() in Node (window guarded).
 */
(function (root) {
  'use strict';

  var SETTLE = 200;

  function clampInt(v, lo, hi) {
    v = Math.trunc(v);
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  var style = {
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
      var L = (pool && pool.length) ? pool.length : 1;
      if (L < 1) L = 1;
      var length = opts.length | 0;
      var octaves = (opts.octaves != null ? opts.octaves : 1) | 0;
      var r = +(opts.r != null ? opts.r : 3.9);
      var x0 = +(opts.x0 != null ? opts.x0 : 0.5);
      var velMode = opts.velMode != null ? opts.velMode : 'fromX';
      var octSpan = (opts.octSpan != null ? opts.octSpan : 1) | 0;

      var octBound = octaves - 1;
      if (octBound < 0) octBound = 0;

      var out = new Array(length);
      var x = x0;
      var i;
      // discard transient
      for (i = 0; i < SETTLE; i++) {
        x = r * x * (1.0 - x);
      }
      // emit
      for (i = 0; i < length; i++) {
        x = r * x * (1.0 - x);
        var xc = x;
        if (xc < 0.0) xc = 0.0;
        else if (xc > 1.0) xc = 1.0;

        var idx = clampInt(Math.floor(xc * L), 0, L - 1);
        var octShift = clampInt(
          Math.floor(xc * (2 * octSpan + 1)) - octSpan,
          -octBound, octBound
        );
        var vel;
        if (velMode === 'fromX') {
          vel = clampInt(40 + Math.floor(xc * 87), 1, 127);
        } else {
          vel = 96;
        }
        out[i] = { idx: idx, octShift: octShift, vel: vel };
      }
      return out;
    }
  };

  // Register onto the shared registry (window in browser, exports in Node).
  if (root) {
    root.ARP_STYLES = root.ARP_STYLES || {};
    root.ARP_STYLES['logistic'] = style;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = style;
  }
})(typeof window !== 'undefined' ? window : null);
