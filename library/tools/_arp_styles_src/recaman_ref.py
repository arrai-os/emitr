#!/usr/bin/env python3
"""
RECAMAN arp style — Python reference implementation (KEPLER provenance).

OEIS A005132 (Recaman's sequence):
  a(0) = start
  a(n) = a(n-1) - n  if  a(n-1) - n > 0  AND  (a(n-1)-n) not in seen-set
         a(n-1) + n  otherwise
  seen-set accumulates every value produced.

Pure integer arithmetic -> bit-exact cross-check with JS (no floats).

Contract (LOCKED):
  gen(pool_len, opts) -> list of {idx:int|None, octShift:int, vel:int}, len == opts['length'].
  opts always has: length, seed, octaves, + style params (start, rest_on_repeat_dir).

Mapping (this style's spec):
  idx      = pmod(a(n), L)
  d        = a(n) - a(n-1)            (n==0 -> octShift = 0)
  octShift = clampInt(round(d / L), -(octaves-1), octaves-1)
  vel      = clampInt(70 + pmod(a(n), 40), 1, 127)        # 70..109
  rest     = only if rest_on_repeat_dir AND the subtract branch was BLOCKED
             (would-subtract value <= 0 OR already in seen) -> idx = None that step.
"""


def clamp_int(v, lo, hi):
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


def pmod(a, m):
    # non-negative modulo (matches JS ((a % m) + m) % m for m > 0)
    return ((a % m) + m) % m


def _round_half_away(x):
    """Round half away from zero, mirroring JS Math.round for the d/L case.

    JS Math.round rounds .5 toward +Infinity. For integer d/L the value is
    exact or exactly k+0.5; we replicate Math.round semantics precisely.
    """
    import math
    # Math.round(x) = floor(x + 0.5)
    return math.floor(x + 0.5)


def gen(pool_len, opts):
    L = max(1, int(pool_len))
    length = int(opts["length"])
    octaves = int(opts.get("octaves", 1))
    start = int(opts.get("start", 0))
    rest_on_repeat_dir = bool(opts.get("rest_on_repeat_dir", False))

    oct_bound = max(0, octaves - 1)

    out = []
    seen = set()

    a_prev = None
    a = start
    seen.add(a)

    for n in range(length):
        if n == 0:
            cur = start
            blocked = False
            d = 0
        else:
            cand_sub = a_prev - n
            if cand_sub > 0 and cand_sub not in seen:
                cur = cand_sub
                blocked = False
            else:
                cur = a_prev + n
                blocked = True
            seen.add(cur)
            d = cur - a_prev

        idx = pmod(cur, L)

        if n == 0:
            oct_shift = 0
        else:
            oct_shift = clamp_int(_round_half_away(d / L), -oct_bound, oct_bound)

        vel = clamp_int(70 + pmod(cur, 40), 1, 127)

        if rest_on_repeat_dir and blocked:
            step = {"idx": None, "octShift": 0, "vel": vel}
        else:
            step = {"idx": idx, "octShift": oct_shift, "vel": vel}

        out.append(step)
        a_prev = cur

    return out


if __name__ == "__main__":
    import json
    import sys

    # Demo / CLI: args = pool_len length seed octaves start rest_on_repeat_dir
    args = sys.argv[1:]
    pool_len = int(args[0]) if len(args) > 0 else 5
    opts = {
        "length": int(args[1]) if len(args) > 1 else 32,
        "seed": int(args[2]) if len(args) > 2 else 1,
        "octaves": int(args[3]) if len(args) > 3 else 1,
        "start": int(args[4]) if len(args) > 4 else 0,
        "rest_on_repeat_dir": (args[5] == "true") if len(args) > 5 else False,
    }
    print(json.dumps(gen(pool_len, opts)))
