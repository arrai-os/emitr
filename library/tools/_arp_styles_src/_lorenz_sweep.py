"""
KEPLER percentile sweep for LORENZ DRIFT arp style.

Computes the 1%/99% percentile bounds (vmin/vmax) for x,y,z of each attractor's
single deterministic orbit (fixed IC = spawn_center + [0.1,0,0], NO RNG),
integrated with the EXACT scalar RK4 used by the generator. These bounds are
baked as frozen literals into both lorenz.js and lorenz_ref.py so the
norm() mapping is reproducible and JS<->Python identical.

Uses the verified field bodies from structures.py (field_js expressions) but
re-implemented as pure scalar python (no numpy in the integrator) so the
arithmetic matches the JS generator bit-for-bit.
"""
import math
import sys, os
sys.path.insert(0, "/Users/emitr/Desktop/AE_Claude /scripts/kepler")
from structures import REGISTRY, field_js  # noqa

# spawn centers from KEPLER registry
SPAWN = {k: REGISTRY[k]["spawn_center"] for k in ("lorenz", "thomas", "rossler")}


def field(attr, p):
    x, y, z = p
    if attr == "lorenz":
        # dx=10(y-x), dy=x(28-z)-y, dz=xy-(8/3)z
        return [10.0 * (y - x), x * (28.0 - z) - y, x * y - (8.0 / 3.0) * z]
    if attr == "thomas":
        b = 0.208186
        return [math.sin(y) - b * x, math.sin(z) - b * y, math.sin(x) - b * z]
    if attr == "rossler":
        return [-y - z, x + 0.2 * y, 0.2 + z * (x - 5.7)]
    raise ValueError(attr)


def rk4_step(attr, p, h):
    k1 = field(attr, p)
    p2 = [p[i] + 0.5 * h * k1[i] for i in range(3)]
    k2 = field(attr, p2)
    p3 = [p[i] + 0.5 * h * k2[i] for i in range(3)]
    k3 = field(attr, p3)
    p4 = [p[i] + h * k3[i] for i in range(3)]
    k4 = field(attr, p4)
    return [p[i] + (h / 6.0) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])
            for i in range(3)]


def percentile(arr, q):
    s = sorted(arr)
    if not s:
        return 0.0
    # linear interpolation (numpy default 'linear')
    idx = (len(s) - 1) * (q / 100.0)
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return s[lo]
    frac = idx - lo
    return s[lo] * (1 - frac) + s[hi] * frac


SETTLE = 500
DT = 0.01           # default dt for the sweep
SWEEP_STEPS = 200000  # long orbit for stable percentiles


def sweep(attr):
    c = SPAWN[attr]
    p = [c[0] + 0.1, c[1] + 0.0, c[2] + 0.0]
    for _ in range(SETTLE):
        p = rk4_step(attr, p, DT)
    xs, ys, zs = [], [], []
    for _ in range(SWEEP_STEPS):
        p = rk4_step(attr, p, DT)
        xs.append(p[0]); ys.append(p[1]); zs.append(p[2])
    out = {}
    for nm, arr in (("x", xs), ("y", ys), ("z", zs)):
        out[nm] = [round(percentile(arr, 1.0), 6), round(percentile(arr, 99.0), 6)]
    return out


if __name__ == "__main__":
    res = {}
    for attr in ("lorenz", "thomas", "rossler"):
        res[attr] = sweep(attr)
        print(attr, res[attr], "field_js=", field_js(attr))
    import json
    print(json.dumps(res))
