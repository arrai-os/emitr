#!/usr/bin/env python3
"""THUE-MORSE arp style — Python reference (KEPLER rigor / provenance).

Mirrors the JS generator bit-exactly per the locked generator contract.

MATH: t(n) = popcount(n) & 1  (parity of set bits, Kernighan loop). Self-similar, cube-free (OEIS A010060).
MAPPING (identical to thuemorse.js):
  running pointer p (start 0) over pool, oct (start 0).
  t(n)==0 -> p += step ;  t(n)==1 -> p -= step
  if n>0 and t(n)!=t(n-1) and flip_octave -> oct = pmod(oct+1, octaves)
  idx      = pmod(p, L)
  octShift = clampInt(oct, -(octaves-1), octaves-1)
  vel      = 100 if t else 72
  rests via rest_bit: 'zero' -> idx=None when t==0; 'one' -> when t==1; 'none' -> no rests
"""
import json
import sys


def pmod(a, n):
    return ((a % n) + n) % n


def clamp_int(v, lo, hi):
    v = int(v)
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


def popcount(x):
    # Kernighan loop on a 32-bit-masked int (matches JS x>>>0).
    x = x & 0xFFFFFFFF
    c = 0
    while x:
        x &= (x - 1) & 0xFFFFFFFF
        c += 1
    return c


def tm(n):
    return popcount(n) & 1


def gen(pool_len, opts):
    L = pool_len if pool_len and pool_len >= 1 else 1
    length = int(opts["length"])
    octaves = int(opts.get("octaves", 1)) or 1
    if octaves < 1:
        octaves = 1
    step = 1 if opts.get("step") is None else int(opts["step"])
    flip_oct = True if opts.get("flip_octave") is None else bool(opts["flip_octave"])
    rest_bit = "none" if opts.get("rest_bit") is None else opts["rest_bit"]

    out = []
    p = 0
    oct = 0
    prev = -1
    for n in range(length):
        t = tm(n)
        if t == 0:
            p += step
        else:
            p -= step
        if n > 0 and t != prev and flip_oct:
            oct = pmod(oct + 1, octaves)
        is_rest = (rest_bit == "zero" and t == 0) or (rest_bit == "one" and t == 1)
        if is_rest:
            out.append({"idx": None, "octShift": 0, "vel": 1})
        else:
            out.append({
                "idx": pmod(p, L),
                "octShift": clamp_int(oct, -(octaves - 1), octaves - 1),
                "vel": 100 if t else 72,
            })
        prev = t
    return out


if __name__ == "__main__":
    pool_len = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    opts = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {
        "length": 32, "seed": 1, "octaves": 1,
        "step": 1, "flip_octave": True, "rest_bit": "none",
    }
    print(json.dumps(gen(pool_len, opts)))
