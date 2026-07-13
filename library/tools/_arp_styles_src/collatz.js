/* COLLATZ arp style — JS generator (KEPLER-verified).
 * Hailstone (3n+1) sequence per seed drives the arpeggiator order:
 * unpredictable climbs and crashes that always resolve home to 1;
 * the phrase length itself is a per-seed instrument.
 *
 * Contract: gen(pool, opts) -> Array<{idx:int|null, octShift:int, vel:int}>
 * length == opts.length. Deterministic (no randomness this style).
 *
 * Mirror of collatz_ref.py. file:// safe + Node require()-able.
 */
(function (root) {
  function pmod(a, m) { return ((a % m) + m) % m; }
  function clampInt(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function hailstone(seed) {
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

  var style = {
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
      var L = (pool && pool.length >= 1) ? pool.length : 1;
      var length = opts.length | 0;
      var octaves = (opts.octaves != null ? opts.octaves : 1) | 0;
      var seed = (opts.seed != null ? opts.seed : 27) | 0;
      var restart = (opts.restart_on_one != null) ? !!opts.restart_on_one : true;

      var sval = clampInt(seed, 1, 200);
      var traj = hailstone(sval);
      var hi = (octaves - 1) > 0 ? (octaves - 1) : 0;
      var lo = -hi;

      var steps = [];
      for (var i = 0; i < length; i++) {
        var h;
        if (i < traj.length) {
          h = traj[i];
        } else if (restart) {
          h = traj[i % traj.length];
        } else {
          steps.push({ idx: null, octShift: 0, vel: 1 });
          continue;
        }
        var idx = pmod(h, L);
        var octShift = clampInt((h % 2 === 1) ? 1 : -1, lo, hi);
        var vel = clampInt(60 + pmod(h, 60), 1, 127);
        steps.push({ idx: idx, octShift: octShift, vel: vel });
      }
      return steps;
    }
  };

  if (root) {
    root.ARP_STYLES = root.ARP_STYLES || {};
    root.ARP_STYLES['collatz'] = style;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = style;
  }
})(typeof window !== 'undefined' ? window : null);
