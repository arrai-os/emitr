/* LORENZ DRIFT — arp style (KEPLER-verified strange-attractor melody).
 *
 * Provenance: field bodies = EXACT KEPLER structures.field_js (params baked);
 * scalar RK4 = integrate._rk4_traj_inc/6 ported to length-3 doubles with
 * IDENTICAL op order to the Python reference (lorenz_ref.py) so JS<->Python
 * output is byte-identical. KEPLER benettin('lorenz') lambda1~=0.906>0 => the
 * orbit is genuinely aperiodic (the butterfly as melody).
 *
 * file:// safe, no fetch, deterministic. require()-able under Node.
 */
(function (root) {
  'use strict';

  // KEPLER spawn_center (structures.REGISTRY)
  var SPAWN_CENTER = {
    lorenz:  [0.0, 0.0, 25.0],
    thomas:  [0.0, 0.0, 0.0],
    rossler: [2.0, 2.0, 0.0]
  };

  // frozen 1%/99% percentile bounds from the KEPLER orbit sweep
  // (200k steps, dt=0.01, IC=spawn_center+[0.1,0,0], SETTLE=500).
  var BOUNDS = {
    lorenz:  { x: [-15.649254, 15.653349], y: [-19.919808, 19.913585], z: [7.362228, 41.348081] },
    thomas:  { x: [-0.973582, 3.745618],  y: [-0.967837, 3.742653],   z: [-0.979606, 3.738019] },
    rossler: { x: [-8.785913, 10.889501], y: [-10.412741, 7.563634],  z: [0.013828, 16.847626] }
  };

  var SETTLE = 500;

  // EXACT KEPLER structures.field_js bodies, params substituted.
  function field(name, x, y, z) {
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
    // rossler
    return [-y - z,
            x + 0.2 * y,
            0.2 + z * (x - 5.7)];
  }

  // rk4 increment numerator (k1+2k2+2k3+k4) — mirrors integrate._rk4_traj_inc.
  function rk4inc(name, p, h) {
    var x = p[0], y = p[1], z = p[2];
    var k1 = field(name, x, y, z);
    var k2 = field(name, x + 0.5 * h * k1[0], y + 0.5 * h * k1[1], z + 0.5 * h * k1[2]);
    var k3 = field(name, x + 0.5 * h * k2[0], y + 0.5 * h * k2[1], z + 0.5 * h * k2[2]);
    var k4 = field(name, x + h * k3[0], y + h * k3[1], z + h * k3[2]);
    return [k1[0] + 2.0 * k2[0] + 2.0 * k3[0] + k4[0],
            k1[1] + 2.0 * k2[1] + 2.0 * k3[1] + k4[1],
            k1[2] + 2.0 * k2[2] + 2.0 * k3[2] + k4[2]];
  }

  function step(name, p, h) {
    var inc = rk4inc(name, p, h);
    return [p[0] + (h / 6.0) * inc[0],
            p[1] + (h / 6.0) * inc[1],
            p[2] + (h / 6.0) * inc[2]];
  }

  function clamp01(v) { return v < 0.0 ? 0.0 : (v > 1.0 ? 1.0 : v); }
  function norm(v, lo, hi) { return clamp01((v - lo) / (hi - lo)); }
  function clampInt(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function gen(pool, opts) {
    var L = Math.max(1, pool.length);
    var length = opts.length | 0;
    var octaves = Math.max(1, opts.octaves | 0);
    var name = opts.attractor || 'lorenz';
    var dt = +opts.dt;
    if (!isFinite(dt)) dt = 0.01;
    var speed = Math.max(1, opts.speed | 0);

    var c = SPAWN_CENTER[name];
    var b = BOUNDS[name];
    var p = [c[0] + 0.1, c[1], c[2]];

    var i, s;
    for (i = 0; i < SETTLE; i++) p = step(name, p, dt);

    var halfOct = Math.floor(octaves / 2);
    var out = new Array(length);
    for (i = 0; i < length; i++) {
      for (s = 0; s < speed; s++) p = step(name, p, dt);
      var nx = norm(p[0], b.x[0], b.x[1]);
      var ny = norm(p[1], b.y[0], b.y[1]);
      var nz = norm(p[2], b.z[0], b.z[1]);
      var idx = clampInt(Math.floor(nx * L), 0, L - 1);
      var octShift = clampInt(Math.floor(nz * octaves) - halfOct, -(octaves - 1), octaves - 1);
      var vel = clampInt(40 + Math.floor(ny * 87.0), 1, 127);
      out[i] = { idx: idx, octShift: octShift, vel: vel };
    }
    return out;
  }

  var style = {
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
    gen: gen
  };

  if (root) {
    root.ARP_STYLES = root.ARP_STYLES || {};
    root.ARP_STYLES['lorenz'] = style;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = style;
  }
})(typeof window !== 'undefined' ? window : null);
