#!/usr/bin/env python3
"""ARP MATH STYLE — automaton (AUTOMATON) · Python reference oracle (KEPLER rigor).

Mirrors _arp_styles_src/automaton.js bit-for-bit. Elementary cellular automaton
(Wolfram), width-w binary row, periodic (wrap) boundaries:
    next cell i = (rule >> ((Ln<<2)|(C<<1)|Rn)) & 1
One generation = one step; advance AFTER emitting the step.

Mapping per generation on the CURRENT row:
    cnt = popcount(row)
    cnt == 0 -> REST {idx:None, octShift:0, vel:0}, reseed centre (keep-alive, no advance)
    else     -> idx = pmod(cnt, L)
                octShift = clampInt(pmod(popcount(leftHalf), octaves), -(octaves-1), octaves-1)
                vel = clampInt(50 + (50 if row[w>>1] else 0) + min(54, cnt*2), 1, 127)
leftHalf = cells strictly left of centre: indices 0 .. (w>>1)-1.

mulberry32 replicated with 32-bit masks so seedMode='random' matches JS exactly.
"""

MASK = 0xFFFFFFFF


def _imul(a, b):
    # JS Math.imul: 32-bit signed multiply. Compute mod 2^32 then sign-fix.
    r = (a & MASK) * (b & MASK) & MASK
    return r - 0x100000000 if r & 0x80000000 else r


def mulberry32(seed):
    s = [(seed & MASK) or 1]

    def nxt():
        s[0] = (s[0] + 0x6D2B79F5) & MASK
        t = s[0]
        t = _imul(t ^ (t >> 15), t | 1) & MASK
        t = (t ^ ((t + _imul(t ^ (t >> 7), t | 61)) & MASK)) & MASK
        return ((t ^ (t >> 14)) & MASK) / 4294967296.0
    return nxt


def clamp_int(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def pmod(a, m):
    return ((a % m) + m) % m


def gen(pool_len, opts):
    L = max(1, int(pool_len))
    N = int(opts["length"])
    octaves = max(1, int(opts.get("octaves", 1)))

    rule = clamp_int(int(opts.get("rule", 90)), 0, 255)
    w = clamp_int(int(opts.get("width", 31)), 5, 63)
    seed_mode = "random" if opts.get("seedMode") == "random" else "center"
    centre = w >> 1

    if seed_mode == "random":
        rng = mulberry32(int(opts.get("seed", 1)))
        row = [1 if rng() < 0.5 else 0 for _ in range(w)]
    else:
        row = [0] * w
        row[centre] = 1

    out = []
    for _ in range(N):
        cnt = sum(row)
        if cnt == 0:
            out.append({"idx": None, "octShift": 0, "vel": 0})
            row[centre] = 1  # keep-alive reseed, no advance
            continue

        left_cnt = sum(row[0:centre])  # strictly left of centre
        idx = pmod(cnt, L)
        oct_shift = clamp_int(pmod(left_cnt, octaves), -(octaves - 1), octaves - 1)
        vel = clamp_int(50 + (50 if row[centre] else 0) + min(54, cnt * 2), 1, 127)
        out.append({"idx": idx, "octShift": oct_shift, "vel": vel})

        nxt = [0] * w
        for c in range(w):
            ln = row[(c - 1 + w) % w]
            cc = row[c]
            rn = row[(c + 1) % w]
            nb = (ln << 2) | (cc << 1) | rn
            nxt[c] = (rule >> nb) & 1
        row = nxt
    return out


# ---- self-test helpers (used by cross-check + gate harness) ----
def evolve_rows(rule, w, gens, seed_mode="center", seed=1):
    """Return the raw bit rows for `gens` generations (no mapping). For Sierpinski check."""
    centre = w >> 1
    if seed_mode == "random":
        rng = mulberry32(seed)
        row = [1 if rng() < 0.5 else 0 for _ in range(w)]
    else:
        row = [0] * w
        row[centre] = 1
    rows = [list(row)]
    for _ in range(gens):
        nxt = [0] * w
        for c in range(w):
            nb = (row[(c - 1 + w) % w] << 2) | (row[c] << 1) | row[(c + 1) % w]
            nxt[c] = (rule >> nb) & 1
        row = nxt
        rows.append(list(row))
    return rows


if __name__ == "__main__":
    import json
    import sys
    pool = [60, 63, 65, 67, 70]
    opts = {"length": 32, "seed": 1, "octaves": 3, "rule": 90, "width": 31, "seedMode": "center"}
    if len(sys.argv) > 1:
        opts.update(json.loads(sys.argv[1]))
    print(json.dumps(gen(len(pool), opts)))
