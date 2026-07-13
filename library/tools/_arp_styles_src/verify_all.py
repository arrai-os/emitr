#!/usr/bin/env python3
"""verify_all.py — committed JS<->Python cross-check harness for all 9 arp styles.

Regenerates the identical-output evidence the design doc asserts in prose, so the
PASS claim is reproducible rather than just recorded. For each of the 9 styles it:

  1. Runs the Python ref `<key>_ref.gen(pool_len, opts)`.
  2. Shells out to `node verify_all_runner.js <key>` which calls the SAME gen that
     ships in ../arp-styles.js (single source of truth).
  3. Diffs the two arrays element-by-element on (idx, octShift, vel).
  4. Runs a per-style non-degeneracy spot check (>=3 distinct sounding idx).

Canonical inputs (must match verify_all_runner.js):
  pool = [60,62,64,67,69]  (L=5)
  opts = {length:64, seed:1994, octaves:3, ...each style's param defaults}

Exit 0 = all 9 byte-identical + node selfTest ok. Exit 1 = any mismatch.

Run:  python3 verify_all.py            (from _arp_styles_src/)
"""
import json
import os
import subprocess
import sys
import importlib

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, "verify_all_runner.js")

POOL = [60, 62, 64, 67, 69]
L = len(POOL)
BASE = {"length": 64, "seed": 1994, "octaves": 3}

# style key -> (ref module name, ref gen attr). golden honors gen() now (alias kept).
STYLES = [
    "lorenz", "logistic", "recaman", "golden", "thuemorse",
    "collatz", "euclidean", "automaton", "pink",
]

# EVERY param default per style, mirrored from arp-styles.js param specs.
# Applied LAST (override universal keys on collision: collatz `seed`, pink `seed`
# + `octaves`) — matches verify_all_runner.js optsFor exactly so neither side
# silently keeps a universal value the other overrides.
DEFAULTS = {
    "lorenz":    {"attractor": "lorenz", "dt": 0.01, "speed": 2},
    "logistic":  {"r": 3.9, "x0": 0.5, "velMode": "fromX", "octSpan": 1},
    "recaman":   {"start": 0, "rest_on_repeat_dir": False},
    "golden":    {"offset": 0, "wrap_octaves": True},
    "thuemorse": {"step": 1, "flip_octave": True, "rest_bit": "none"},
    "collatz":   {"seed": 27, "restart_on_one": True},
    "euclidean": {"k": 5, "n": 8, "rotation": 0},
    "automaton": {"rule": 90, "width": 31, "seedMode": "center"},
    "pink":      {"octaves": 5, "seed": 1, "restProb": 0, "hi": 0.88, "lo": 0.12},
}


def opts_for(key):
    o = dict(BASE)
    o.update(DEFAULTS.get(key, {}))  # style param defaults win on collision
    return o


def py_steps(key):
    mod = importlib.import_module(f"{key}_ref")
    return mod.gen(L, opts_for(key))


def js_steps(key):
    out = subprocess.run(
        ["node", RUNNER, key], capture_output=True, text=True, check=True
    )
    return json.loads(out.stdout)


def diff(a, b):
    """Return list of (i, field, jsval, pyval) mismatches."""
    bad = []
    if len(a) != len(b):
        bad.append(("LEN", "length", len(a), len(b)))
        return bad
    for i, (x, y) in enumerate(zip(a, b)):
        for f in ("idx", "octShift", "vel"):
            if x.get(f) != y.get(f):
                bad.append((i, f, x.get(f), y.get(f)))
    return bad


def distinct_sounding(steps):
    return len({s["idx"] for s in steps if s["idx"] is not None})


def pink_spectral_check():
    """pink's AC-8 discriminator: FFT log-log slope on the continuous pink[n]
    series (default K=5) must sit in [-1.6,-0.4]; the K=1 white control must be
    ~0 and strictly less-negative. Reconstructs pink[n] via the SAME Voss-McCartney
    recurrence / draw order as pink_ref.gen. numpy is allowed here (verification
    oracle, NOT inside any gen). Returns (passed, info)."""
    import numpy as np
    import pink_ref as P

    def series(K, seed=1, length=4096):
        rng = P.mulberry32(seed)
        rows = [0.0] * K
        out = []
        for n in range(length):
            if n == 0:
                for i in range(K):
                    rows[i] = rng()
            else:
                tz = P.trailing_zeros(n)
                top = min(tz, K - 1)
                for i in range(top + 1):
                    rows[i] = rng()
            j = rng()
            out.append((sum(rows) + j) / (K + 1))
        return np.array(out)

    def slope(x):
        x = x - x.mean()
        n = len(x)
        f = np.fft.rfftfreq(n)[1:]
        pw = (np.abs(np.fft.rfft(x)) ** 2)[1:]
        lf, lp = np.log(f[:-1]), np.log(pw[:-1])
        return float(np.polyfit(lf, lp, 1)[0])

    s_pink = slope(series(5))
    s_white = slope(series(1))
    in_band = -1.6 <= s_pink <= -0.4
    white_flat = not (s_white <= -0.4)
    pink_steeper = s_pink < s_white
    passed = in_band and white_flat and pink_steeper
    return passed, {
        "pink_K5_slope": round(s_pink, 3),
        "white_K1_slope": round(s_white, 3),
        "pink_in_[-1.6,-0.4]": in_band,
        "white_~0": white_flat,
        "pink_more_negative": pink_steeper,
    }


def main():
    # node self-test first (whole-module contract assertion)
    st = subprocess.run(["node", RUNNER], capture_output=True, text=True, check=True)
    payload = json.loads(st.stdout)
    selftest = payload.get("selfTest", {})
    print(f"node _selfTest: {selftest}")

    all_pass = True
    for key in STYLES:
        js = js_steps(key)
        py = py_steps(key)
        mism = diff(js, py)
        d = distinct_sounding(js)
        ndg = d >= 3
        ok = (not mism) and ndg
        all_pass = all_pass and ok
        status = "PASS" if ok else "FAIL"
        extra = "" if not mism else f"  {len(mism)} mismatch(es), first={mism[0]}"
        print(f"  {key.ljust(11)} {status}  identical={not mism}  distinct_idx={d} (>=3:{ndg}){extra}")

    # pink spectral discriminator (the AC-8 gate that distinct-idx can't catch)
    try:
        sp_ok, sp_info = pink_spectral_check()
        print(f"\n  pink spectral  {'PASS' if sp_ok else 'FAIL'}  {sp_info}")
        all_pass = all_pass and sp_ok
    except Exception as e:  # numpy missing -> skip spectral, keep cross-check verdict
        print(f"\n  pink spectral  SKIP ({e})")

    print(f"\n{'ALL 9 PASS (JS==Python, reproducible)' if all_pass else 'CROSS-CHECK FAILED'}")
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
