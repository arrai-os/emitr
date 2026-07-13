/*
 * RECAMAN arp style — JS generator (verified source / provenance).
 *
 * OEIS A005132 (Recaman's sequence):
 *   a(0) = start
 *   a(n) = a(n-1) - n  if  a(n-1)-n > 0  AND  (a(n-1)-n) not in seen-set
 *          a(n-1) + n  otherwise
 *   seen-set accumulates every value.
 *
 * Pure integer arithmetic => bit-exact cross-check with the Python reference.
 *
 * Registers onto window.ARP_STYLES (browser) and exports under Node (guarded).
 * Self-contained helpers so it runs standalone for the cross-check; identical
 * to the shared arp-styles.js helpers (clampInt, pmod).
 */
(function (root) {
  function clampInt(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }
  function pmod(a, m) {
    return ((a % m) + m) % m;
  }

  var recaman = {
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
      var seen = Object.create(null); // integer set
      var aPrev = null;

      seen[start] = true;

      for (var n = 0; n < length; n++) {
        var cur, blocked, d;
        if (n === 0) {
          cur = start;
          blocked = false;
          d = 0;
        } else {
          var candSub = aPrev - n;
          if (candSub > 0 && !seen[candSub]) {
            cur = candSub;
            blocked = false;
          } else {
            cur = aPrev + n;
            blocked = true;
          }
          seen[cur] = true;
          d = cur - aPrev;
        }

        var idx = pmod(cur, L);
        var octShift = (n === 0) ? 0 : clampInt(Math.round(d / L), -octBound, octBound);
        var vel = clampInt(70 + pmod(cur, 40), 1, 127);

        if (restOnRepeatDir && blocked) {
          out.push({ idx: null, octShift: 0, vel: vel });
        } else {
          out.push({ idx: idx, octShift: octShift, vel: vel });
        }
        aPrev = cur;
      }
      return out;
    }
  };

  if (root) {
    root.ARP_STYLES = root.ARP_STYLES || {};
    root.ARP_STYLES.recaman = recaman;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = recaman;
  }
})(typeof window !== 'undefined' ? window : null);
