"""COLLATZ arp style — Python reference implementation (KEPLER provenance).

Hailstone (3n+1) sequence per seed drives the arpeggiator order.
Contract mirror of collatz.js :: gen(pool, opts).

A style step = {"idx": int|None, "octShift": int, "vel": int}.

Math (locked):
  Hailstone trajectory of seed s>0:
    h = s; traj = []
    while h != 1: traj.append(h); h = h//2 if h even else 3*h+1
    traj.append(1)            # always resolves home to 1
  Fill `length`:
    - if len(traj) < length:
        restart_on_one True  -> restart from s and wrap (cycle traj)
        restart_on_one False -> pad tail with REST steps (idx=None)
    - if len(traj) > length: truncate to length
  Per emitted h:
    idx      = pmod(h, L)
    octShift = clampInt(+1 if h is odd else -1, -(octaves-1), octaves-1)
    vel      = clampInt(60 + pmod(h, 60), 1, 127)   # 60..119

Determinism: pure function of (L, opts). No randomness used by this style,
but seed is part of opts for contract uniformity.
"""


def pmod(a, m):
    """Non-negative modulo."""
    return ((a % m) + m) % m


def clamp_int(v, lo, hi):
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


def hailstone(seed):
    """Full hailstone trajectory: seed ... 1 (inclusive)."""
    h = int(seed)
    if h < 1:
        h = 1
    traj = []
    while h != 1:
        traj.append(h)
        h = h // 2 if (h % 2 == 0) else 3 * h + 1
    traj.append(1)
    return traj


def gen(pool_len, opts):
    L = pool_len if pool_len >= 1 else 1
    length = int(opts["length"])
    octaves = int(opts.get("octaves", 1))
    seed = int(opts.get("seed", 27))
    restart_on_one = bool(opts.get("restart_on_one", True))

    sval = clamp_int(seed, 1, 200)
    traj = hailstone(sval)
    hi = octaves - 1 if octaves - 1 > 0 else 0
    lo = -hi

    steps = []
    for i in range(length):
        if i < len(traj):
            h = traj[i]
        else:
            if restart_on_one:
                h = traj[i % len(traj)]
            else:
                steps.append({"idx": None, "octShift": 0, "vel": 1})
                continue
        idx = pmod(h, L)
        octShift = clamp_int(1 if (h % 2 == 1) else -1, lo, hi)
        vel = clamp_int(60 + pmod(h, 60), 1, 127)
        steps.append({"idx": idx, "octShift": octShift, "vel": vel})
    return steps


if __name__ == "__main__":
    import json
    import sys
    pool = [60, 63, 65, 67, 70]
    opts = {"length": 32, "seed": 1, "octaves": 1,
            "restart_on_one": True}
    if len(sys.argv) > 1:
        opts.update(json.loads(sys.argv[1]))
    print(json.dumps(gen(len(pool), opts)))
