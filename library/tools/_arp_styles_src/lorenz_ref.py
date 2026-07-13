"""
LORENZ DRIFT — Python reference generator (KEPLER-verified).

Provenance: math is the KEPLER attractor registry
(scripts/kepler/structures.py field bodies + scripts/kepler/integrate.py
scalar RK4 = _rk4_traj_inc/6). This file re-implements the SAME scalar RK4 in
pure Python (no numpy in the hot path) so it is bit-exact-comparable against the
JS gen, which is the cross-check requirement.

Contract (LOCKED): gen(pool_len, opts) -> list of {idx, octShift, vel}.
  opts: length, seed (unused here — orbit is deterministic from fixed IC),
        octaves, attractor ('lorenz'|'thomas'|'rossler'), dt (float), speed (int).

Mapping (per spec):
  norm(v) = clamp((v-vmin)/(vmax-vmin), 0, 1)
  idx     = clampInt(floor(norm(x)*L), 0, L-1)
  octShift= clampInt(floor(norm(z)*octaves) - floor(octaves/2),
                     -(octaves-1), octaves-1)
  vel     = clampInt(40 + floor(norm(y)*87), 1, 127)
  never null.

KEPLER rigor: integrate.benettin('lorenz') lambda1 ~= 0.906 > 0 recorded
(positive largest Lyapunov exponent => genuine sensitive dependence => aperiodic).
"""
import math


# ── baked field bodies (EXACT KEPLER structures.field_js, params substituted) ──
def _field(name, x, y, z):
    if name == "lorenz":
        return (10.0 * (y - x),
                x * (28.0 - z) - y,
                x * y - (8.0 / 3.0) * z)
    if name == "thomas":
        b = 0.208186
        return (math.sin(y) - b * x,
                math.sin(z) - b * y,
                math.sin(x) - b * z)
    if name == "rossler":
        return (-y - z,
                x + 0.2 * y,
                0.2 + z * (x - 5.7))
    raise ValueError("unknown attractor: " + name)


# ── KEPLER spawn_center (structures.REGISTRY) ──────────────────────────────
_SPAWN_CENTER = {
    "lorenz":  (0.0, 0.0, 25.0),
    "thomas":  (0.0, 0.0, 0.0),
    "rossler": (2.0, 2.0, 0.0),
}

# ── frozen 1%/99% percentile bounds from KEPLER orbit sweep (200k steps,
#    dt=0.01, IC=spawn_center+[0.1,0,0], SETTLE=500). See ARP-STYLES-DESIGN.md. ──
_BOUNDS = {
    "lorenz":  {"x": (-15.649254, 15.653349),
                "y": (-19.919808, 19.913585),
                "z": (7.362228, 41.348081)},
    "thomas":  {"x": (-0.973582, 3.745618),
                "y": (-0.967837, 3.742653),
                "z": (-0.979606, 3.738019)},
    "rossler": {"x": (-8.785913, 10.889501),
                "y": (-10.412741, 7.563634),
                "z": (0.013828, 16.847626)},
}

_SETTLE = 500


def _rk4_inc(name, p, h):
    """rk4 increment numerator (k1+2k2+2k3+k4), matching integrate._rk4_traj_inc."""
    x, y, z = p
    k1 = _field(name, x, y, z)
    k2 = _field(name, x + 0.5 * h * k1[0], y + 0.5 * h * k1[1], z + 0.5 * h * k1[2])
    k3 = _field(name, x + 0.5 * h * k2[0], y + 0.5 * h * k2[1], z + 0.5 * h * k2[2])
    k4 = _field(name, x + h * k3[0], y + h * k3[1], z + h * k3[2])
    return (k1[0] + 2.0 * k2[0] + 2.0 * k3[0] + k4[0],
            k1[1] + 2.0 * k2[1] + 2.0 * k3[1] + k4[1],
            k1[2] + 2.0 * k2[2] + 2.0 * k3[2] + k4[2])


def _step(name, p, h):
    inc = _rk4_inc(name, p, h)
    return (p[0] + (h / 6.0) * inc[0],
            p[1] + (h / 6.0) * inc[1],
            p[2] + (h / 6.0) * inc[2])


def _clamp01(v):
    if v < 0.0:
        return 0.0
    if v > 1.0:
        return 1.0
    return v


def _norm(v, lo, hi):
    return _clamp01((v - lo) / (hi - lo))


def _clamp_int(v, lo, hi):
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


def gen(pool_len, opts):
    L = max(1, int(pool_len))
    length = int(opts["length"])
    octaves = max(1, int(opts.get("octaves", 1)))
    name = opts.get("attractor", "lorenz")
    dt = float(opts.get("dt", 0.01))
    speed = max(1, int(opts.get("speed", 2)))

    c = _SPAWN_CENTER[name]
    b = _BOUNDS[name]
    p = (c[0] + 0.1, c[1], c[2])

    # discard SETTLE transient RK4 steps
    for _ in range(_SETTLE):
        p = _step(name, p, dt)

    out = []
    half_oct = octaves // 2  # floor(octaves/2)
    for _ in range(length):
        for _ in range(speed):
            p = _step(name, p, dt)
        nx = _norm(p[0], b["x"][0], b["x"][1])
        ny = _norm(p[1], b["y"][0], b["y"][1])
        nz = _norm(p[2], b["z"][0], b["z"][1])
        idx = _clamp_int(int(math.floor(nx * L)), 0, L - 1)
        oct_shift = _clamp_int(int(math.floor(nz * octaves)) - half_oct,
                               -(octaves - 1), octaves - 1)
        vel = _clamp_int(40 + int(math.floor(ny * 87.0)), 1, 127)
        out.append({"idx": idx, "octShift": oct_shift, "vel": vel})
    return out


if __name__ == "__main__":
    import json
    import sys
    pool = [60, 63, 65, 67, 70]
    opts = {"length": 32, "seed": 1, "octaves": 2,
            "attractor": "lorenz", "dt": 0.01, "speed": 2}
    if len(sys.argv) > 1:
        opts.update(json.loads(sys.argv[1]))
    print(json.dumps(gen(len(pool), opts)))
