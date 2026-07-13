"""
EUCLIDEAN arp style — Python reference implementation (KEPLER provenance).

Contract (LOCKED):
  gen(pool_len, opts) -> list[ {idx:int|None, octShift:int, vel:int} ] of length opts['length']
  Deterministic pure function of (pool_len, opts).

Math:
  Bjorklund(k, n) distributes k pulses maximally evenly over n steps
  (Euclid/GCD recursion -> binary pattern). Rotate left by `rotation`:
  pat[(i + rotation) % n]. Tile to fill length: step i uses pat[i % n].

Mapping:
  1 FIRES -> note ; 0 -> REST (idx=None).
  Pulse counter p advances ONLY on fires.
  On fire:
    idx      = pmod(p, L)
    octShift = clampInt( pmod(floor(p / L), octaves), -(octaves-1), octaves-1 )
    vel      = 110 if (i % n == 0) else 70   # downbeat accent
    then p += 1
  On rest: {idx:None, octShift:0, vel:0}

Params: k (int 1-16, default 5); n (int 2-32, default 8); rotation (int 0-31, default 0)
"""
import math


def pmod(a, m):
    """Non-negative modulo (matches JS pmod)."""
    return ((a % m) + m) % m


def clamp_int(v, lo, hi):
    v = int(math.floor(v)) if not isinstance(v, int) else v
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


def bjorklund(k, n):
    """
    Maximally-even distribution of k pulses across n steps.
    Returns a list of n ints (1=pulse, 0=rest). Classic Bjorklund algorithm.
    """
    k = int(k)
    n = int(n)
    if n <= 0:
        return []
    if k <= 0:
        return [0] * n
    if k >= n:
        return [1] * n

    # Canonical Bjorklund (Toussaint). Two stacks of bit-sequences:
    #   `seqs`      = the k pulse groups,    each [1]
    #   `remainder` = the (n-k) rest groups, each [0]
    # Repeatedly distribute the smaller stack into the larger until <=1 remainder.
    seqs = [[1] for _ in range(k)]
    remainder = [[0] for _ in range(n - k)]

    while len(remainder) > 1:
        new_seqs = []
        new_remainder = []
        m = min(len(seqs), len(remainder))
        for i in range(m):
            new_seqs.append(seqs[i] + remainder[i])
        # leftovers from whichever stack was longer become the new remainder
        if len(seqs) > len(remainder):
            new_remainder = seqs[m:]
        else:
            new_remainder = remainder[m:]
        seqs = new_seqs
        remainder = new_remainder

    # Flatten: pulse groups first, then the single leftover remainder group.
    pattern = []
    for g in seqs:
        pattern.extend(g)
    for g in remainder:
        pattern.extend(g)
    return pattern


def gen(pool_len, opts):
    L = max(1, int(pool_len))
    length = int(opts['length'])
    octaves = int(opts.get('octaves', 1))
    if octaves < 1:
        octaves = 1

    k = int(opts.get('k', 5))
    n = int(opts.get('n', 8))
    rotation = int(opts.get('rotation', 0))
    if n < 1:
        n = 1

    pat = bjorklund(k, n)  # length n

    steps = []
    p = 0  # pulse counter, advances only on fires
    for i in range(length):
        bit = pat[pmod(i + rotation, n)]
        if bit == 1:
            idx = pmod(p, L)
            oct_shift = clamp_int(pmod(p // L, octaves), -(octaves - 1), octaves - 1)
            vel = 110 if (i % n == 0) else 70
            steps.append({'idx': idx, 'octShift': oct_shift, 'vel': vel})
            p += 1
        else:
            steps.append({'idx': None, 'octShift': 0, 'vel': 0})
    return steps


if __name__ == '__main__':
    import json
    import sys
    pool_len = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    opts = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {
        'length': 32, 'seed': 1, 'octaves': 1, 'k': 5, 'n': 8, 'rotation': 0}
    print(json.dumps(gen(pool_len, opts)))
