"""PINK 1/F — Python reference implementation (KEPLER-rigor cross-check oracle).

Voss-McCartney 1/f pink noise -> arp step program.
Contract: gen(pool_len, opts) -> list of {idx, octShift, vel}, length == opts['length'].
Deterministic: pure function of (pool_len, opts). All randomness via bit-exact mulberry32.

This MUST be byte-identical to _arp_styles_src/pink.js gen() for the same inputs.
All ops masked &0xFFFFFFFF to mirror JS uint32 / Math.imul semantics.

Spec recap (LOCKED):
  K = octaves (param). rows[0..K-1] init from rng() at n=0.
  Per step n>0: trailing = #trailing-zero-bits(n); for i in 0..trailing: rows[i]=rng();
                then one white-jitter draw j=rng(); pink[n]=(sum(rows)+j)/(K+1) in [0,1).
  Draws/step = trailing+2  (n=0 init: K row draws + 1 jitter).
  Wait — n=0: rows all drawn (K draws) then jitter (1) => K+1 draws at n=0.
  n>0: (trailing+1) row redraws + 1 jitter => trailing+2 draws.
  Mapping: p=pink[n]; pprev (=p at n=0).
    idx = pmod(floor(p*L), L)
    octShift = +1 if p>hi else (-1 if p<lo else 0), clamped +/-(octaves-1)
    d = abs(p - pprev); vel = clampInt(round(48 + 79*(0.35*p + 0.65*min(1, d*4))), 1, 127)
  rests: if restProb>0, draw rr=rng() AFTER value+jitter; rr<restProb -> idx=null.
         (restProb default 0 => no extra draw, all sound.)
"""

MASK = 0xFFFFFFFF


def _imul(a, b):
    # JS Math.imul: 32-bit signed multiply; we keep unsigned 32 then interpret consistently.
    return (a * b) & MASK


def mulberry32(seed):
    """Returns a closure yielding floats in [0,1), bit-exact mirror of the JS PRNG."""
    s = (seed & MASK) or 1

    def rng():
        nonlocal s
        s = (s + 0x6D2B79F5) & MASK
        t = s
        t = _imul(t ^ (t >> 15), t | 1) & MASK
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & MASK
        t &= MASK
        return ((t ^ (t >> 14)) & MASK) / 4294967296.0

    return rng


def clamp_int(v, lo, hi):
    v = int(v)
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


def pmod(a, n):
    return ((a % n) + n) % n


def trailing_zeros(n):
    """#trailing zero bits of n (n>=1). For n with the lowest set bit position."""
    if n == 0:
        return 0
    t = 0
    while (n & 1) == 0:
        n >>= 1
        t += 1
    return t


def gen(pool_len, opts):
    L = int(pool_len)
    length = int(opts["length"])
    seed = int(opts.get("seed", 1))
    octaves = int(opts.get("octaves", 5))
    K = int(opts.get("octaves", octaves))  # octaves param == K (# summed sources)
    rest_prob = float(opts.get("restProb", 0.0))
    hi = float(opts.get("hi", 0.88))
    lo = float(opts.get("lo", 0.12))

    rng = mulberry32(seed)
    oct_bound = max(0, octaves - 1)

    rows = [0.0] * K
    out = []
    pprev = None

    for n in range(length):
        if n == 0:
            for i in range(K):
                rows[i] = rng()
        else:
            tz = trailing_zeros(n)
            # redraw rows 0..tz inclusive
            top = min(tz, K - 1)
            for i in range(top + 1):
                rows[i] = rng()
        j = rng()
        p = (sum(rows) + j) / (K + 1)

        if pprev is None:
            pprev = p

        idx = pmod(_floor(p * L), L)
        if p > hi:
            octShift = 1
        elif p < lo:
            octShift = -1
        else:
            octShift = 0
        octShift = clamp_int(octShift, -oct_bound, oct_bound)

        d = abs(p - pprev)
        # JS Math.round = floor(x + 0.5) for x >= 0 (round half up). vel arg always >= 0.
        vel = clamp_int(_floor(48 + 79 * (0.35 * p + 0.65 * min(1.0, d * 4.0)) + 0.5), 1, 127)

        is_rest = False
        if rest_prob > 0.0:
            rr = rng()
            if rr < rest_prob:
                is_rest = True

        if is_rest:
            out.append({"idx": None, "octShift": 0, "vel": 0})
        else:
            out.append({"idx": idx, "octShift": octShift, "vel": vel})

        pprev = p

    return out


def _floor(x):
    import math
    return int(math.floor(x))


# ---- known-value / gate helpers ----
def distinct_idx(steps):
    return len({s["idx"] for s in steps if s["idx"] is not None})


if __name__ == "__main__":
    import json
    import sys
    pool_len = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    opts = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {
        "length": 32, "seed": 1, "octaves": 5, "restProb": 0, "hi": 0.88, "lo": 0.12
    }
    print(json.dumps(gen(pool_len, opts)))
