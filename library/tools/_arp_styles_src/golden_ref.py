"""GOLDEN arp style — Python reference implementation (KEPLER provenance).

Phyllotaxis index. phi = (1 + sqrt(5)) / 2.
g(n) = floor((n + offset) * phi)

Mapping (LOCKED, mirrors golden.js bit-for-bit):
  idx      = pmod(g(n), L)
  octShift = clampInt(pmod(g(n)//L, octaves), -(octaves-1), octaves-1)  if wrap_octaves else 0
  vel      = clampInt(64 + pmod(g(n), 50), 1, 127)   # 64..113
  no rests (maximally even, dense).

Contract: gen(pool_len, opts) -> list[dict{idx, octShift, vel}] of length opts['length'].
(gen_golden is kept as a back-compat alias; all 9 refs now honor the same gen() name.)
Deterministic, pure function of (pool_len, opts).

math.sqrt(5) and math.floor are IEEE-754 identical to JS Math.sqrt(5)/Math.floor,
so the float path is bit-exact across runtimes.
"""
import math

PHI = (1.0 + math.sqrt(5.0)) / 2.0


def pmod(a, n):
    """Non-negative modulo (matches JS ((a % n) + n) % n)."""
    return ((a % n) + n) % n


def clamp_int(v, lo, hi):
    v = int(v)
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


def gen(pool_len, opts):
    L = pool_len
    length = int(opts["length"])
    octaves = int(opts.get("octaves", 1))
    offset = int(opts.get("offset", 0))
    wrap_octaves = bool(opts.get("wrap_octaves", True))

    out = []
    for n in range(length):
        g = math.floor((n + offset) * PHI)
        idx = pmod(g, L)
        if wrap_octaves and octaves > 1:
            oct_raw = pmod(g // L, octaves)
            oct_shift = clamp_int(oct_raw, -(octaves - 1), octaves - 1)
        else:
            oct_shift = 0
        vel = clamp_int(64 + pmod(g, 50), 1, 127)
        out.append({"idx": idx, "octShift": oct_shift, "vel": vel})
    return out


# back-compat alias (golden_ref originally exposed gen_golden)
gen_golden = gen


# ---- gate + known-value checks (importable + runnable) ----

def golden_g(n, offset=0):
    return math.floor((n + offset) * PHI)


def check_known_values():
    """OEIS-style known g(0..11) for offset=0: 0,1,3,4,6,8,9,11,12,14,16,17."""
    expected = [0, 1, 3, 4, 6, 8, 9, 11, 12, 14, 16, 17]
    got = [golden_g(n, 0) for n in range(12)]
    return got == expected, got, expected


def gate(pool_len, opts):
    """Non-degeneracy gate. Returns (passed, info)."""
    steps = gen_golden(pool_len, opts)
    idxs = [s["idx"] for s in steps]
    distinct = len(set(idxs))
    length = len(idxs)

    not_all_rest = any(s["idx"] is not None for s in steps)
    non_constant = distinct > 1
    min_distinct = min(pool_len, math.floor(length * 0.6))
    enough_distinct = distinct >= max(3, 1) and distinct >= min(min_distinct, 3) if pool_len >= 3 else distinct >= 1
    # spec: distinct idx count >= min(L, floor(length*0.6)); plus general >=3 rule
    spec_distinct = distinct >= min(pool_len, math.floor(length * 0.6))

    # aperiodicity: no repeating period < L over the idx stream
    aperiodic = True
    for p in range(1, min(pool_len, length)):
        if length > p and all(idxs[i] == idxs[i - p] for i in range(p, length)):
            aperiodic = False
            break

    kv_ok, _, _ = check_known_values()

    passed = (
        not_all_rest
        and non_constant
        and distinct >= 3
        and spec_distinct
        and aperiodic
        and kv_ok
    )
    info = {
        "distinct": distinct,
        "not_all_rest": not_all_rest,
        "non_constant": non_constant,
        "ge3_distinct": distinct >= 3,
        "spec_distinct(>=min(L,0.6N))": spec_distinct,
        "aperiodic": aperiodic,
        "known_values_ok": kv_ok,
        "min_distinct_required": min(pool_len, math.floor(length * 0.6)),
    }
    return passed, info


if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "crosscheck":
        pool_len = int(sys.argv[2])
        opts = json.loads(sys.argv[3])
        print(json.dumps(gen_golden(pool_len, opts)))
    else:
        # default: cross-check pool + gate report
        pool = [60, 63, 65, 67, 70]
        opts = {"length": 32, "seed": 1, "octaves": 1, "offset": 0, "wrap_octaves": True}
        print(json.dumps(gen_golden(len(pool), opts)))
