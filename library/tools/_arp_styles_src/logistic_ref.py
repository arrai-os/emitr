#!/usr/bin/env python3
"""
LOGISTIC arp style — Python reference implementation (KEPLER rigor).

Math:  1-D logistic map  x_{n+1} = r * x_n * (1 - x_n).
From a fixed x0, discard SETTLE=200 transient iterations, then emit one note
per iteration (the post-settle value drives the step).

Contract (LOCKED):
  - input:  pool_len (int, == len(pool), L>=1), opts (dict)
  - opts:   length:int, seed:int, octaves:int, r:float, x0:float,
            velMode:str ('fromX'|'fixed'), octSpan:int
  - output: list of length opts['length'] of {'idx','octShift','vel'}

Mapping (LOCKED, per spec):
  x in [0,1]:
    idx      = clampInt(floor(x*L), 0, L-1)
    octShift = clampInt(floor(x*(2*octSpan+1)) - octSpan, -(octaves-1), octaves-1)
    vel      = fromX ? clampInt(40 + floor(x*87), 1, 127) : 96
  never null (no rests).

Determinism: pure function of (pool_len, opts). Single double `x`, identical
recurrence in Python and JS. SETTLE before emission stabilizes onto the attractor.

The logistic map is a verified KEPLER-class 1-D dynamical system; this reference
uses the same plain double-precision recurrence the JS generator uses (no numpy
needed for the recurrence — bit-identical scalar float64 in both languages).
"""
from __future__ import annotations
import math

SETTLE = 200


def clamp_int(v: int, lo: int, hi: int) -> int:
    v = int(v)
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


def gen(pool_len: int, opts: dict) -> list:
    L = int(pool_len)
    if L < 1:
        L = 1
    length = int(opts["length"])
    octaves = int(opts.get("octaves", 1))
    r = float(opts.get("r", 3.9))
    x0 = float(opts.get("x0", 0.5))
    vel_mode = opts.get("velMode", "fromX")
    oct_span = int(opts.get("octSpan", 1))

    oct_bound = octaves - 1
    if oct_bound < 0:
        oct_bound = 0

    out = []
    x = x0
    # discard transient
    for _ in range(SETTLE):
        x = r * x * (1.0 - x)
    # emit
    for _ in range(length):
        x = r * x * (1.0 - x)
        # clamp x into [0,1] defensively (map can numerically nudge out for r near 4)
        xc = x
        if xc < 0.0:
            xc = 0.0
        elif xc > 1.0:
            xc = 1.0

        idx = clamp_int(math.floor(xc * L), 0, L - 1)
        octShift = clamp_int(
            math.floor(xc * (2 * oct_span + 1)) - oct_span,
            -oct_bound,
            oct_bound,
        )
        if vel_mode == "fromX":
            vel = clamp_int(40 + math.floor(xc * 87), 1, 127)
        else:
            vel = 96
        out.append({"idx": idx, "octShift": octShift, "vel": vel})
    return out


if __name__ == "__main__":
    import json
    import sys

    pool_len = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    opts = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {
        "length": 32, "seed": 1, "octaves": 1,
        "r": 3.9, "x0": 0.5, "velMode": "fromX", "octSpan": 1,
    }
    print(json.dumps(gen(pool_len, opts)))
