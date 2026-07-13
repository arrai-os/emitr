# ARP MATH STYLES — KEPLER Design Record

**Status:** LOCKED SPEC · build target for 9 parallel agents
**Date:** 2026-06-30
**Method:** KEPLER rigor — "LLM proposes, Python disposes." Every numeric claim is checked against a Python reference oracle and a Node-run JS implementation; **PASS requires element-by-element identical output.**

This document is the single source of truth. The 9 build agents implement against the contract below WITHOUT deviation. Reviewers verify against the gates below.

---

## 0. WHY THIS DESIGN (decisions, not hedges)

The arpeggiator + firestarter engines already share one architecture:
`buildArpCycle(state, pitches)` → an ordered **pitch cycle**; `idx = stepIndex % cycle.length` picks the note; per-step `velocities[]` + gate pattern decorate it.

The 9 math styles need three degrees of freedom the existing cycle does not carry: **scale-degree index, octave shift, and per-step velocity, all as a function of step number n** (and possibly aperiodic over the whole length, not a short repeating cycle). So the styles do NOT emit a pitch cycle — they emit a **full per-step program** of length `opts.length`. The engines route to the styles through one thin adapter (`applyArpStyle`) that converts each `{idx, octShift, vel}` into the same `{pitches, velocity}` shape the existing render/export/live paths already consume. **Existing modes are untouched** — the style path is a sibling branch keyed off `window.ARP_STYLES[mode]`.

**Determinism decision (the load-bearing one).** The contract requires JS↔Python bit-identical output, including the three float-based styles (lorenz, logistic, pink). We therefore FORBID any numpy/scipy dependency inside `gen`. The chaos styles do NOT call KEPLER's `field_numpy` at generation time. Instead:

- KEPLER is reused for **provenance + validation only**: `structures.field_js(name)` emits the exact scalar `Math.*` field body (sympy `jscode`), and `integrate.benettin` proves λ₁ > 0. The per-attractor `vmin/vmax` normalization constants are baked once from a KEPLER percentile sweep and frozen as literals in the style.
- The shipped `gen` integrates a **single 3-vector** with plain scalar RK4 using only `Math.*` (JS) and the identical double-precision operation order in Python (`math.*`, no numpy). Same IEEE-754 doubles + same op order + same `Math.floor`/modulo quantization ⇒ identical integer step output. This is the ONLY way the cross-check can pass on float styles.

All randomness (pink, automaton random seed) flows through ONE shared **mulberry32** uint32 PRNG with 32-bit-masked integer arithmetic, replicated bit-exactly in Python (`& 0xFFFFFFFF`).

---

## 1. MODULE CONTRACT (`window.ARP_STYLES`)

`arp-styles.js` is plain vanilla JS, loadable via `<script src>` on `file://` AND `require()`-able under Node (guard every `window` access). It defines a registry of style objects:

```js
(function (root) {
  'use strict';

  // ---- shared mulberry32 PRNG (bit-exact JS<->Python) ----
  function mulberry32(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- shared helpers (clamp, mod, popcount, etc.) ----
  function clampInt(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function pmod(a, m) { return ((a % m) + m) % m; }   // non-negative modulo

  var STYLES = {
    lorenz:   { /* ... */ },
    logistic: { /* ... */ },
    recaman:  { /* ... */ },
    golden:   { /* ... */ },
    thuemorse:{ /* ... */ },
    collatz:  { /* ... */ },
    euclidean:{ /* ... */ },
    automaton:{ /* ... */ },
    pink:     { /* ... */ }
  };

  var API = { STYLES: STYLES, mulberry32: mulberry32, clampInt: clampInt, pmod: pmod,
              keys: Object.keys(STYLES) };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; // Node
  if (root) root.ARP_STYLES = STYLES;                                       // browser
  if (root) root.ARP_STYLES_API = API;
})(typeof window !== 'undefined' ? window : null);
```

### Style object shape (EXACT — every style implements this)

```
{
  key:    string,      // registry key, e.g. 'lorenz' (MUST equal the registry property name)
  label:  string,      // UI display, e.g. 'LORENZ DRIFT'
  family: string,      // 'chaos-attractors' | 'number-sequences' | 'rhythm-automata' | 'stochastic-structured'
  params: [
    { name:string, type:'int'|'float'|'enum'|'bool',
      min?:number, max?:number, default:any, options?:string[], descr:string }
  ],
  gen: function (pool, opts) -> Array<StepObject> of length opts.length
}
```

### `gen(pool, opts)` signature — LOCKED

- **`pool`** : ascending `Array<int>` of MIDI pitch numbers — the arp's resolved chord/scale tones for the base octave span. The engine builds it. `gen` reads `pool.length` (= `L`) for index math; it does NOT need the actual pitch values (the adapter maps `idx`→pitch). `gen` MUST handle `L >= 1`.
- **`opts`** : object, always contains:
  - `length` : int — number of step objects to return (REQUIRED, == returned array length).
  - `seed` : int — deterministic randomness seed (REQUIRED; styles with no randomness ignore it).
  - `octaves` : int — octave span the engine is stacking (REQUIRED; bounds octShift).
  - plus every style param by `name` with its resolved value (defaults filled by the engine/adapter).
- **Return** : `Array` of exactly `opts.length` StepObjects (see §2).
- **DETERMINISM (REQUIRED):** `gen` is a pure function of `(pool.length, opts)`. Same inputs ⇒ byte-identical output every call. No `Date.now`, no `Math.random`, no global mutation. All randomness via `mulberry32(opts.seed)`.

### Registration
A style is registered by adding it as a property of the `STYLES` object literal in `arp-styles.js`, keyed by its `key`. No other registration step. The tools enumerate `Object.keys(window.ARP_STYLES)` to build the mode `<option>`s and read `window.ARP_STYLES[mode].params` to build the param panel.

---

## 2. STEP OBJECT — LOCKED

`gen` returns an array of:

```
{ idx: int|null, octShift: int, vel: int }
```

| field | rule |
|---|---|
| `idx` | Integer pool selector. The engine plays `pool[ ((idx % L) + L) % L ]` (non-negative modulo; styles SHOULD pre-reduce but the adapter re-applies defensively). **`idx === null` ⇒ a REST** (no note this step). |
| `octShift` | Integer added as `12 * octShift` semitones to the chosen pitch. MUST be within `[-(octaves-1), +(octaves-1)]` (styles clamp). `0` = no shift. Ignored when `idx===null`. |
| `vel` | Integer MIDI velocity in `[1, 127]` (styles clamp). Ignored when `idx===null`. |

The adapter (`applyArpStyle`, §7) converts each StepObject to the engine's native shape:
- `idx===null` → that step is a rest (sets the step's gate `pattern[i]=false`; no pitch).
- else → pitch = `pool[pmod(idx, L)] + 12*octShift`, written into a length-`length` cycle/pitch array, and `velocities[i] = vel`.

This means the style program drives BOTH the pitch sequence AND the per-step velocity AND the gate (rests) — without touching the existing mode code paths.

---

## 3. THE 9 STYLES

All keys are EXACTLY: `lorenz, logistic, recaman, golden, thuemorse, collatz, euclidean, automaton, pink`.

`L = pool.length`. Non-negative modulo `pmod(a,m) = ((a%m)+m)%m`. JS `Math.floor` == Python `math.floor`; JS `>>>`/`Math.imul` mirrored in Python with `& 0xFFFFFFFF`.

### Cross-check harness (uniform)
Unless a style overrides below, the canonical cross-check is:
`pool = [60,62,64,67,69]` (L=5), `opts = {length:64, seed:1994, octaves:3, ...style defaults}`.
JS array (run under Node) MUST equal Python ref array element-by-element on `(idx, octShift, vel)`.

---

### (1) `lorenz` — LORENZ DRIFT · family `chaos-attractors`

**Math.** Single-orbit scalar RK4 of a KEPLER attractor (enum `attractor ∈ {lorenz, thomas, rossler}`). Field bodies are the EXACT `Math.*` expressions emitted by `structures.field_js(name)`:
- `lorenz`: `dx=σ(y−x)`, `dy=x(ρ−z)−y`, `dz=xy−βz`; σ=10, ρ=28, β=8/3.
- `thomas`: `dx=sin(y)−b·x`, `dy=sin(z)−b·y`, `dz=sin(x)−b·z`; b=0.208186.
- `rossler`: `dx=−y−z`, `dy=x+a·y`, `dz=b+z(x−c)`; a=0.2, b=0.2, c=5.7.

Fixed deterministic IC: `p0 = spawn_center + [0.1, 0.0, 0.0]` (KEPLER spawn_center per attractor; NO RNG — replaces benettin's `rng.standard_normal` so JS==Python). Discard transient **SETTLE=500** RK4 steps, then advance `speed` RK4 steps per emitted note. Scalar RK4 = the `_rk4_traj_inc/6` form from `integrate.py` ported to a length-3 array of doubles, identical op order both languages.

**Mapping** (per note, after settling): normalize each coord against baked per-attractor `vmin/vmax` (frozen literals from a KEPLER 1% / 99% percentile sweep): `norm(v)=clamp((v−vmin)/(vmax−vmin),0,1)`.
- `idx = clampInt(floor(norm(x) * L), 0, L-1)`.
- `octShift = floor(norm(z) * octaves) − floor(octaves/2)`, clamped `±(octaves-1)`.
- `vel = clampInt(40 + floor(norm(y) * 87), 1, 127)`.
- never null (chaos = continuous).

**Params:** `attractor`(enum {lorenz,thomas,rossler}, default lorenz) · `dt`(float 0.001–0.05, default 0.01) · `speed`(int 1–8, default 2).

**Gate.** Provenance: `integrate.benettin('lorenz')` λ₁≈0.906 > 0 (proven, recorded). Output gate: ≥3 distinct idx; **aperiodic** — no exact repeating period ≤ length/2 in the idx array. Cross-check identical JS↔Python (baked vmin/vmax + identical RK4). **AC-8 fail:** `dt=0.0001, speed=1` → orbit barely advances → <3 distinct idx → MUST fail.

**Character.** Organic, breathing, never exactly repeats; melodic phrases that recur in feel but never literally — the butterfly as melody.

---

### (2) `logistic` — LOGISTIC · family `chaos-attractors`

**Math.** 1-D map `x_{n+1} = r·x_n·(1−x_n)`. From fixed `x0`, discard **SETTLE=200**, then emit one note per iteration. Single double `x`, identical recurrence both languages.

**Mapping** (per iteration, `x ∈ [0,1]`):
- `idx = clampInt(floor(x * L), 0, L-1)`.
- `octShift = floor(x * (2*octSpan+1)) − octSpan`, clamped `±(octaves-1)`.
- `vel = velMode==='fromX' ? clampInt(40 + floor(x*87),1,127) : 96`.
- never null.

**Params:** `r`(float 2.4–4.0, default 3.9) · `x0`(float 0.01–0.99, default 0.5) · `velMode`(enum {fromX,fixed}, default fromX) · `octSpan`(int 0–2, default 1).

**Gate.** With `r≥3.57`: ≥3 distinct idx + aperiodic (map Lyapunov `mean(log|r(1−2x)|)>0`). Verify known logistic behaviour at `r=3.9` (avoid the absorbing-0 trap; `x0=0.5` chosen so it never lands exactly on 0). **AC-8 fail (by design):** `r=3.2` → period-2 → exactly 2 distinct idx → MUST fail the ≥3 gate. The `r` knob IS the live order→chaos morph.

**Character.** Live morph from locked ostinato (low r) into spraying chaos (r→4); turn one knob to dissolve order in real time.

---

### (3) `recaman` — RECAMÁN · family `number-sequences`

**Math.** OEIS A005132. `a(0)=start`; `a(n)=a(n-1)−n` if `a(n-1)−n > 0` and not in seen-set, else `a(n)=a(n-1)+n`. Seen-set accumulates every value. Pure integer.

**Mapping** (per n):
- `idx = pmod(a(n), L)`.
- `octShift`: `d=a(n)−a(n-1)`; `octShift = clampInt(round(d / L), -(octaves-1), octaves-1)` (big leaps push octave). At n=0, `octShift=0`.
- `vel = 70 + pmod(a(n), 40)` → 70..109 (clamp 1..127 defensively).
- rests: only if `rest_on_repeat_dir=true` AND the subtract branch was BLOCKED (would-subtract value ≤0 or already seen) → emit `idx=null` that step.

**Params:** `start`(int 0–4, default 0) · `rest_on_repeat_dir`(bool, default false).

**Gate.** With `start=0`, assert `a(0..11) = 0,1,3,6,2,7,13,20,12,21,11,22`. ≥3 distinct idx over length≥16; not constant. Cross-check identical (pure int).

**Character.** Big leaps then sudden returns to revisit territory — restless, searching; the most "composed-sounding" of the sequence styles.

---

### (4) `golden` — GOLDEN · family `number-sequences`

**Math.** Phyllotaxis index. `phi=(1+Math.sqrt(5))/2` (IEEE-754 identical JS/Python). `g(n)=Math.floor((n+offset)*phi)`. `Math.sqrt(5)` + `Math.floor` are bit-identical to Python `math.sqrt(5)`/`math.floor`.

**Mapping** (per n):
- `idx = pmod(g(n), L)`.
- `octShift = wrap_octaves ? pmod(Math.floor(g(n)/L), octaves) : 0`, clamped `±(octaves-1)`. (Spiral climbs octaves as it wraps; for octaves>1 keep within range via clamp.)
- `vel = 64 + pmod(g(n), 50)` → 64..113.
- no rests (maximally even, dense by design).

**Params:** `offset`(int 0–50, default 0) · `wrap_octaves`(bool, default true).

**Gate.** Assert `g(0..11) = 0,1,3,4,6,8,9,11,12,14,16,17`. Maximally even ⇒ distinct idx count `≥ min(L, floor(length*0.6))`; aperiodic (φ irrational ⇒ no period < L). **AC-8 fail:** `L=1` (pool length 1) → every `idx = g(n)%1 = 0` → constant → MUST fail "≥3 distinct / not constant". (Python ref mirrors so the failing case is identical.)

**Character.** Maximally even, never-repeating spiral — a shimmering, evenly-spread cascade that feels endless and unrepeating (Fibonacci sunflower as arp).

---

### (5) `thuemorse` — THUE-MORSE · family `number-sequences`

**Math.** `t(n) = popcount(n) & 1` (parity of set bits, Kernighan loop). Self-similar, cube-free.

**Mapping.** Running pointer `p` (start 0) over the pool; maintain `oct` (start 0):
- on `t(n)==0`: `p += step`. on `t(n)==1`: `p −= step`.
- if `n>0` and `t(n) != t(n-1)` and `flip_octave`: `oct = pmod(oct+1, octaves)`.
- `idx = pmod(p, L)`.
- `octShift = clampInt(oct, -(octaves-1), octaves-1)` (oct is 0..octaves-1; non-negative fold).
- `vel = t(n) ? 100 : 72`.
- rests via `rest_bit`: if `rest_bit==='zero'` emit `idx=null` when `t(n)==0`; if `'one'` when `t(n)==1`; `'none'` = no rests.

**Params:** `step`(int 1–4, default 1) · `flip_octave`(bool, default true) · `rest_bit`(enum {none,zero,one}, default none).

**Gate.** Assert `t(0..11)=0,1,1,0,1,0,0,1,1,0,0,1`. With `rest_bit=none`: ≥3 distinct idx, not all one value, aperiodic (cube-free ⇒ no short period). Cross-check identical.

**Character.** Fractal self-similarity — direction flips that nest at every scale; hypnotic, mathematically inevitable, the same shape at every zoom.

---

### (6) `collatz` — COLLATZ · family `number-sequences`

**Math.** Hailstone per seed `s>0`: `h=s`; while `h≠1`: append `h`, then `h = (h even) ? h/2 : 3h+1`; finally append `1`. Build the full trajectory, then fill `length`: if shorter and `restart_on_one`, **restart from `s` and wrap**; if longer, truncate. If `restart_on_one=false`, pad the tail after `1` with `idx=null` rests.

**Mapping** (per emitted `h`):
- `idx = pmod(h, L)`.
- `octShift = (h & 1) ? +1 : −1`, clamped `±(octaves-1)` (odd=rise like 3n+1, even=fall like n/2).
- `vel = 60 + pmod(h, 60)` → 60..119.

**Params:** `seed`(int 1–200, default 27) · `restart_on_one`(bool, default true).

**Gate.** Assert seed 6 → `6,3,10,5,16,8,4,2,1`; seed 7 → `7,22,11,34,17,52,26,13,40,20,10,5,16,8,4,2,1`. ≥3 distinct idx; phrase length varies by seed (assert `len(traj(6)) ≠ len(traj(7))`). Cross-check identical.

**Character.** Unpredictable hailstone climbs and crashes that always resolve home to 1; phrase length itself is a per-seed instrument.

---

### (7) `euclidean` — EUCLIDEAN · family `rhythm-automata`

**Math.** Bjorklund(k,n) distributes `k` pulses maximally evenly over `n` steps (Euclid/GCD recursion → binary pattern). Rotate left by `rotation`: `pat[(i+rotation)%n]`. Tile to fill `length`: step `i` uses `pat[i % n]`.

**Mapping.** A `1` FIRES → note; a `0` → REST (`idx=null`). A pulse counter `p` advances ONLY on fires (rests don't advance the melody):
- on fire: `idx = pmod(p, L)`; `octShift = clampInt(pmod(Math.floor(p / L), octaves), -(octaves-1), octaves-1)` (rising octave each pool wrap); `vel = (i % n === 0) ? 110 : 70` (downbeat accent); then `p++`.
- on rest: `{idx:null, octShift:0, vel:0}`.

**Params:** `k`(int 1–16, default 5) · `n`(int 2–32, default 8) · `rotation`(int 0–31, default 0).

**Gate.** Assert fired count over one n-cycle == `k` (true Bjorklund pulse count). Known patterns (rotation 0), literal-string verified: `E(3,8)=10010010` ✓ · `E(5,8)=10110110` ✓ · `E(2,5)=10100` ✓. For `E(5,16)` the canonical fold gives `1001001001001000` — a maximally-even **rotation** of the spec-listed `1001001000100100` (identical gap multiset {3,3,3,3,4}, pulse count 5); both are valid E(5,16) differing only by starting phase (documented Bjorklund rotation ambiguity), so the gate asserts the maximally-even *property* (gap multiset + count) not the phase-dependent literal. ≥3 distinct fired idx; not all rests; pattern over n not all-same.

**AC-8 fail.** Spec listed `k=1,n=8` → 1 fired idx, but under the LOCKED mapping the pulse counter `p` advances monotonically *across* cycles, so `k=1,n=8,length=32` → 4 distinct idx (p=0..3) and would PASS — the spec assumed a per-cycle reset. The mathematically-correct degenerate config exercising the same ≥3-distinct rule is **`k=1, n=8, length=8`** (one cycle → one pulse → fired idx `[0]`), which correctly FAILS. (Pool collapse `L=1` is an equivalent degeneracy.) Verified: the gate discriminates.

**Verification result (KEPLER).** Cross-check JS (registry `window.ARP_STYLES.euclidean.gen`) vs Python `euclidean_ref.gen` on pool `[60,63,65,67,70]`, opts `{length:32,seed:1,octaves:1,k:5,n:8,rotation:0}` → **byte-identical, 0 mismatches over 32 steps**. Non-degeneracy gate (default): 5 distinct fired idx, 20/32 fired (12 rests), fired-in-cycle == 5 == k, pattern bits `10110110` ✓. AC-8 `k=1,n=8,length=8` → 1 distinct idx → FAILS. **VERDICT: PASS.**

**Character.** World-rhythm pulse grids (tresillo, cumbia, Euclidean techno) — the groove lives in WHERE notes land, not which; instantly danceable.

---

### (8) `automaton` — AUTOMATON · family `rhythm-automata`

**Math.** Elementary CA, width-`w` binary row, periodic (wrap) boundaries. Next cell `i`: `(rule >> ((Ln<<2)|(C<<1)|Rn)) & 1` where `Ln,C,Rn` = left/centre/right neighbours (wrap). Seed row: `seedMode='center'` → single live centre `w>>1`; `seedMode='random'` → `mulberry32(opts.seed)`, cell live if `rng()<0.5`. One generation = one step; advance AFTER emitting.

**Mapping** (per generation, on current row):
- `cnt = popcount(row)`.
- if `cnt===0`: emit `{idx:null,octShift:0,vel:0}` (REST) AND reseed to centre cell (keeps it alive, deterministically).
- else: `idx = pmod(cnt, L)`; `octShift = clampInt(pmod(popcount(leftHalf), octaves), -(octaves-1), octaves-1)` (left-density → register); `vel = clampInt(50 + (row[w>>1]?50:0) + Math.min(54, cnt*2), 1, 127)`.

**Params:** `rule`(int 0–255, default 90; presets 30/90/110 surfaced as quick-buttons) · `width`(int 5–63, default 31, odd preferred) · `seedMode`(enum {center,random}, default center).

**Gate.** Cross-check full 32-generation row evolution bit-for-bit JS↔Python. Rule 90 from lone centre = Sierpiński: gen1 has exactly 2 live cells at ±1; gen2 at ±2. Rule 30 from lone centre: gen1 = three live at −1,0,+1. Over `length` gens: ≥3 distinct idx, aperiodic for rule 30/110 (no period < length/2), not all-rests, not constant popcount. **AC-8 fail:** `rule=0` → all cells die → reseed→die loop → collapses to constant/all-rest → MUST fail.

**Character.** A living organism — Rule 30 spits chaotic sparks, Rule 90 draws Sierpiński cascades, Rule 110 weaves complex evolving motifs; the pattern grows rather than loops.

---

### (9) `pink` — PINK 1/F · family `stochastic-structured`

**Math.** Voss-McCartney 1/f pink noise. `K=octaves` (param) summed sources. At step n: `trailing = #trailing-zero-bits(n)`; for `i in 0..trailing`: `rows[i]=rng()`; then one white-jitter draw `j=rng()`; `pink[n] = (sum(rows)+j)/(K+1) ∈ [0,1)`. Draws per step = `trailing+2`, identical both languages. `rng = mulberry32(opts.seed)` (bit-exact). At n=0 init all `rows[i]=rng()` (i=0..K-1) before the loop so the stream order is fixed and documented in the ref.

**Mapping** (per step, `p=pink[n]`, `pprev`=previous pink, `pprev=p` at n=0):
- `idx = pmod(floor(p * L), L)`.
- `octShift`: `0`; if `p>hi` → `+1`; if `p<lo` → `−1`; clamp `±(octaves-1)`.
- `d = abs(p − pprev)`; `vel = clampInt(round(48 + 79*(0.35*p + 0.65*min(1, d*4))), 1, 127)`.
- rests: if `restProb>0`, draw `rr=rng()` AFTER the value+jitter draws; `rr<restProb` → `idx=null`. (Default 0 ⇒ all sound; the extra draw only happens when restProb>0, and the ref documents this exactly.)

**Params:** `octaves`(int 2–8, default 5 — this is K, # summed sources) · `seed`(int 0–2147483647, default 1) · `restProb`(float 0–0.4, default 0) · `hi`(float 0.5–1, default 0.88) · `lo`(float 0–0.5, default 0.12).

> NOTE: `pink` reads its OWN `octaves` param as K, distinct from the engine octave-span. The adapter passes the style's octaves param; octShift is still bounded by the engine octave span via clamp. Builders MUST treat `opts.octaves` here as K AND as the octShift bound (default 5 covers both; clamp keeps octShift valid).

**Gate.** Cross-check pool=7 tones, `length=64, seed=12345, octaves=5`: identical JS↔Python. ≥3 distinct idx; not all-rests; not constant. **Spectral test:** FFT `pink[n]`, fit `log(power) ~ slope·log(freq)`; require `slope ∈ [−1.6, −0.4]` AND strictly more-negative than a white-noise control (single-source) of equal length from the same PRNG. Pitch spread ≥ `min(4, L)`. **AC-8 fail:** `octaves=1` → single white source → slope ≈ 0 → fails the `slope ≤ −0.4` band (the spectral discriminator does the work even if pitch-spread passes).

**Character.** The natural musical wander — between white-noise randomness and brownian drift; melodies that meander with memory, the spectral signature of real human-composed contours.

---

## 4. VERIFICATION PROTOCOL (per style, KEPLER gate)

1. Python ref `_arp_styles_src/<key>_ref.py` — same contract, returns the same array shape (list of dicts `{idx,octShift,vel}`).
2. JS source `_arp_styles_src/<key>.js` (and merged into `arp-styles.js`), run under Node.
3. **CROSS-CHECK**: fixed pool + fixed opts/seed (the harness above, or the per-style override) → arrays IDENTICAL element-by-element on `(idx, octShift, vel)`. Float styles MUST match exactly via identical doubles + quantization; if divergence appears, fix the formulation until identical.
4. **NON-DEGENERACY GATE**: ≥3 distinct idx; not all-rests; not constant; chaotic styles aperiodic over length; euclidean fired-count == k; thuemorse/recaman/golden/collatz match their known/OEIS values.
5. **AC-8 SPIRIT**: each style ships ONE documented degenerate config that SHOULD fail the gate, proving the gate discriminates.

`node --check` every JS file. The Python refs are the oracle; the JS is what ships.

---

## 5. INTEGRATION (both tools)

### Load order
Each tool loads `arp-styles.js` via `<script src>` BEFORE its own inline script (arpeggiator.html) / before `firestarter-core.js`:
```html
<script src="arp-styles.js"></script>
<!-- arpeggiator: then the existing inline <script> -->
<!-- firestarter: <script src="firestarter-core.js"></script> after -->
```

### Mode selector
Both tools have `<select id="mode">` with the 9 existing options. Append a disabled `<optgroup label="MATH">` (or 4 family optgroups) and one `<option value="<key>">` per `window.ARP_STYLES` key, enumerated at init so adding a style needs no HTML edit.

### The branch point (where order is produced)
- **arpeggiator.html** `buildArpCycle(pitches)` / `generateSequence()` (~line 517 / 595): if `state.mode` is a math-style key, route to the adapter (§7) which returns the full per-step program; otherwise the existing `switch` runs unchanged.
- **firestarter-core.js** `buildArpCycle(clip, pitches)` (line 338), `resolveArpNotes` (line 403), and the live `fireArpStep` (line 834): all three consult the adapter when `clip.mode` is a math key. The adapter output is cached per `(mode, params, L, octaves, length, seed)` signature exactly like `_arpCycleCache` so the live path stays allocation-free per tick.

### The adapter (`applyArpStyle`) — shared shape, implemented in each tool
```
applyArpStyle(mode, pool, opts) ->
  { program: Array<{idx,octShift,vel}>,        // raw style output
    pitches: Array<int|null>,                  // length=opts.length, resolved MIDI (null=rest)
    velocities: Array<int>,                    // length=opts.length
    rests: Array<bool> }                       // length=opts.length (true where idx===null)
// pitches[i] = (program[i].idx===null) ? null
//            : pool[pmod(program[i].idx, pool.length)] + 12*program[i].octShift
```
The engine then drives its existing render/export/live paths from `pitches`/`velocities`/`rests` — math styles produce a **direct length-N program** (not a repeating cycle), and rests set the per-step gate so the existing rest handling (incl. firestarter HOLD latch) keeps working.

### Param panel
When a math style is selected, render a compact param panel (EMITR design) below the mode selector from `window.ARP_STYLES[mode].params`. On any param change, recompute the program and redraw (offline) / invalidate the live cache. When a non-math mode is selected, hide the panel — existing controls behave exactly as before.

---

## 6. EMITR DESIGN (param UI)
bg `#060606`, surface `#0e0e0e`, border `#1a1a1a`, accent `#8b2020`/`#b83030`, text `#e8e8e8`/`#888`; `Bebas Neue` display + `Azeret Mono` body; grain; thin scrollbar. Param panel appears only when a math style is the active mode.

---

## 7. NON-NEGOTIABLES (every builder applies)
- `node --check` passes on every JS file; Python refs run clean.
- Cross-check PASS (identical arrays) is the gate of record — no style ships without it.
- No numpy/scipy inside `gen`; chaos floats use scalar `Math.*` only; all randomness via the shared mulberry32.
- Do NOT regress existing modes — the style path is a sibling branch keyed off `window.ARP_STYLES[mode]`; if `mode` is not a style key, original code runs verbatim.
- Reuse KEPLER (`structures.field_js`, `integrate.benettin`) for chaos field bodies + λ proof + baked vmin/vmax; do not reinvent attractor integration.

---

## VERIFICATION REPORT — `golden` (GOLDEN) · VERIFIED 2026-06-30

- **Source:** `_arp_styles_src/golden.js` (JS gen) + `_arp_styles_src/golden_ref.py` (Python ref). `node --check` PASS, `ast.parse` PASS.
- **Cross-check (PASS — identical):** fixed pool `[60,63,65,67,70]` (L=5).
  - opts `{length:32, seed:1, octaves:1, offset:0, wrap_octaves:true}` → JS array == Python array element-by-element (idx/octShift/vel). First 6: `(0,0,64)(1,0,65)(3,0,67)(4,0,68)(1,0,70)(3,0,72)`.
  - octave path opts `{length:48, octaves:3, offset:7, wrap_octaves:true}` → also byte-identical; octShifts seen `{0,1,2}` (clamp range exercised).
- **Known values (PASS):** `g(0..11) = [0,1,3,4,6,8,9,11,12,14,16,17]` — matches the phyllotaxis/Beatty sequence ⌊nφ⌋ exactly (JS Math.sqrt(5)/Math.floor == Python math.sqrt(5)/math.floor, IEEE-754).
- **Non-degeneracy gate (PASS, L=5):** distinct idx = 5 (≥3 and ≥ min(L, ⌊0.6·N⌋)=5); not-all-rest; non-constant; aperiodic (no period < L, φ irrational); known-values OK.
- **AC-8 discrimination (PASS):** degenerate config L=1 → every idx = g(n)%1 = 0 → constant → gate **FAILS** (non_constant=False, distinct=1). Healthy passes, degenerate fails ⇒ gate discriminates. Python ref mirrors the identical failing output.
- **Verdict: PASS.**

---

## VERIFICATION REPORT — `thuemorse` (THUE-MORSE) · VERIFIED 2026-06-30

- **Source:** `_arp_styles_src/thuemorse.js` (JS gen) + `_arp_styles_src/thuemorse_ref.py` (Python ref). `node --check` PASS, `ast.parse` PASS. No randomness — pure parity sequence (seed ignored), so determinism is structural.
- **Math:** `t(n) = popcount(n) & 1` via Kernighan loop (`x &= x-1`), 32-bit-masked in Python (`& 0xFFFFFFFF`) to mirror JS `>>>`. Running pointer `p` (±step per bit), `oct` advances on parity changes when `flip_octave`, `idx=pmod(p,L)`, `octShift=clampInt(oct,-(oct-1),oct-1)`, `vel = t?100:72`, rests via `rest_bit`.
- **Cross-check (PASS — identical):** fixed pool `[60,63,65,67,70]` (L=5).
  - Default opts `{length:32, seed:1, octaves:1, step:1, flip_octave:true, rest_bit:none}` → JS array == Python array element-by-element (idx/octShift/vel).
  - Also byte-identical under `{length:64, octaves:2}` (octShift set `{0,1}` exercised), under `rest_bit:'one'` (32 rests over 64 = exactly the count of 1-bits), and across `step ∈ {1,2,3,4}`.
- **Known values (PASS):** `t(0..11) = [0,1,1,0,1,0,0,1,1,0,0,1]` — matches OEIS A010060 exactly.
- **Non-degeneracy gate (PASS, L=5):** distinct idx = 3 (≥3); not-all-rest; non-constant; **aperiodic** — shortest repeating period of the idx array over length 128 = NONE (cube-free ⇒ the *order* never repeats even though the pitch set is small — this is the characteristic Thue-Morse "hovering" band). Known-values OK.
- **Note on distinct count:** Thue-Morse parity is balanced (equal 0/1 in prefixes), so the pointer `p` oscillates in a narrow band → exactly 3 residues mod 5 regardless of `step`. Mathematically correct; the musical life is in the aperiodic *ordering*, not pitch breadth. Meets the `≥3 distinct` gate.
- **AC-8 discrimination (PASS):** degenerate config `step=0` → pointer never moves → single constant idx → gate **FAILS** ("fewer than 3 distinct idx (1)"). Cross-check on the degenerate config also identical JS↔Python. Healthy passes, degenerate fails ⇒ gate discriminates.
- **Verdict: PASS.**

---

## VERIFICATION REPORT — `recaman` (RECAMAN) · VERIFIED 2026-06-30

- **Math:** OEIS A005132. `a(0)=start`; `a(n)=a(n-1)-n` if `a(n-1)-n>0` AND not in seen-set, else `a(n)=a(n-1)+n`; seen-set accumulates every value. Pure integer (no floats -> no IEEE-754 risk).
- **Mapping:** `idx = pmod(a(n), L)`; `d = a(n)-a(n-1)` (n=0 -> octShift=0); `octShift = clampInt(round(d/L), -(octaves-1), octaves-1)`; `vel = clampInt(70 + pmod(a(n),40), 1, 127)` -> 70..109. Rest only when `rest_on_repeat_dir=true` AND the subtract branch was BLOCKED (would-subtract <=0 or already seen) -> `idx=null`.
- **Params:** `start` (int 0-4, default 0); `rest_on_repeat_dir` (bool, default false).
- **Source:** `_arp_styles_src/recaman.js` (JS gen) + `_arp_styles_src/recaman_ref.py` (Python ref). `node --check` PASS, `ast.parse` PASS. Registered into shared `arp-styles.js` (`STYLES.recaman`), verified byte-identical to the ref across 3 configs (incl. seed 7 / start 2 / octaves 3 / rest_on_repeat_dir).
- **Cross-check (PASS — identical):** fixed pool `[60,63,65,67,70]` (L=5), opts `{length:32, seed:1, octaves:1, start:0, rest_on_repeat_dir:false}` -> JS array == Python array element-by-element (idx/octShift/vel), 32/32 steps. First 12 idx = `[0,1,3,1,2,2,3,0,2,1,1,2]` = A005132[0..11] mod 5.
- **Known values (PASS):** raw `a(0..11)` (measured via large-L run so idx==a(n)) = `[0,1,3,6,2,7,13,20,12,21,11,22]` — exact OEIS A005132 (start=0) match in BOTH JS and Python.
- **Non-degeneracy gate (PASS, L=5):** distinct idx = 5 (>=3); not all-rest; non-constant; aperiodic (no period <=16 over length 32); vel range 70..95 (within 70..109); OEIS known-values OK. With `rest_on_repeat_dir=true`: 18/32 rests but gate still PASS (distinct=5).
- **AC-8 discrimination (PASS):** degenerate config `length=2` (start=0) -> idx `[0,1]` only 2 distinct -> gate **FAILS** (`<3 distinct idx`). Healthy passes, degenerate fails => gate discriminates.
- **Verdict: PASS.**

---

## VERIFICATION REPORT — `lorenz` (LORENZ DRIFT) · VERIFIED 2026-06-30

- **Source:** `_arp_styles_src/lorenz.js` (JS gen) + `_arp_styles_src/lorenz_ref.py` (Python ref). `node --check` PASS, `ast.parse` PASS. No RNG — orbit is fully deterministic from a fixed IC, so determinism is structural (seed ignored).
- **Math / provenance:** field bodies are the EXACT `structures.field_js` expressions (lorenz sigma=10/rho=28/beta=8/3; thomas b=0.208186; rossler a=0.2/b=0.2/c=5.7). IC `p0 = spawn_center + [0.1,0,0]` from KEPLER `spawn_center` (lorenz [0,0,25], thomas [0,0,0], rossler [2,2,0]). Scalar RK4 = `integrate._rk4_traj_inc/6` ported to length-3 doubles with identical op order both languages. SETTLE=500 transient discarded, then `speed` RK4 steps per note.
- **Lyapunov (KEPLER oracle, `integrate.benettin('lorenz')`):** lambda1 = **0.867 > 0** (sensitive dependence => aperiodic), sum(lambda) = **-13.67 < 0** (dissipative), Kaplan-Yorke ~= 2.06 => genuine strange attractor. Matches the spec-recorded lambda1~=0.906.
- **Baked normalization:** per-attractor 1%/99% `vmin/vmax` frozen from a 200k-step orbit sweep (dt=0.01, same IC, after SETTLE=500). lorenz x(-15.65,15.65) y(-19.92,19.91) z(7.36,41.35); thomas/rossler likewise (literals in source).
- **Mapping:** `norm(v)=clamp((v-vmin)/(vmax-vmin),0,1)`; `idx=clampInt(floor(norm(x)*L),0,L-1)`; `octShift=clampInt(floor(norm(z)*octaves)-floor(octaves/2),+/-(octaves-1))`; `vel=clampInt(40+floor(norm(y)*87),1,127)`; never null.
- **Cross-check (PASS — identical):** fixed pool `[60,63,65,67,70]` (L=5), byte-identical JS<->Python element-by-element (idx/octShift/vel) across all three attractors:
  - lorenz `{length:32, seed:1, octaves:2, dt:0.01, speed:2}` -> 32 steps identical.
  - thomas `{length:48, seed:7, octaves:3, dt:0.02, speed:3}` -> 48 steps identical.
  - rossler `{length:40, seed:3, octaves:2, dt:0.015, speed:4}` -> 40 steps identical.
  Bit-exactness from identical IEEE-754 doubles + identical op order + identical `Math.floor`/clamp quantization (no numpy in `gen`).
- **Non-degeneracy gate (PASS):** default `{lorenz, dt:0.01, speed:2}`, L=5, length 64 -> distinct idx = 3 (>=3); not-all-rest; non-constant; **aperiodic** (no exact repeating period <= length/2). On L=7 pool: 4 distinct idx, octShift set {-1,0,1}, vel range 41-83.
- **AC-8 discrimination (PASS):** degenerate config `dt=0.0001, speed=1` -> orbit barely advances -> distinct idx = 1 -> gate **FAILS** (distinct<3, constant, periodic). Healthy passes, degenerate fails => gate discriminates.
- **Verdict: PASS.**

## AUTOMATON (`automaton`) — family: rhythm-automata

**Math.** Elementary cellular automaton (Wolfram). A width-`w` binary row evolves under an 8-bit `rule` (0-255) with **periodic (wrap) boundaries**:

    next[i] = (rule >> ((Ln<<2) | (C<<1) | Rn)) & 1,   Ln=row[(i-1) mod w], C=row[i], Rn=row[(i+1) mod w]

One generation = one emitted step; the CA advances **after** emitting the step. Seed: `center` = single live centre cell (`w>>1`); `random` = `mulberry32(seed)` fill (cell live iff `rng()<0.5`).

**Mapping (on the CURRENT row, per generation).**
- `cnt = popcount(row)`.
- `cnt===0` → emit REST `{idx:null, octShift:0, vel:0}` and **reseed the centre cell** (deterministic keep-alive); do NOT advance this step.
- else: `idx = pmod(cnt, L)`; `octShift = clampInt(pmod(popcount(leftHalf), octaves), -(octaves-1), octaves-1)` (leftHalf = indices `0..(w>>1)-1`, register driven by left density); `vel = clampInt(50 + (row[w>>1]?50:0) + min(54, cnt*2), 1, 127)`.

**Params.** `rule` (int 0-255, default 90; presets 30 chaotic / 90 Sierpinski / 110 complex) · `width` (int 5-63, default 31, odd preferred) · `seedMode` (enum center|random, default center).

**Character.** A living organism: Rule 30 chaotic sparks, Rule 90 Sierpinski cascades, Rule 110 complex evolving motifs — the pattern grows rather than loops.

### Verification (KEPLER rigor — PASS)
- **Cross-check (JS↔Python, bit-for-bit).** PASS on 5 configs (rule 30/90/110, center+random seeds, widths 25/31/63). Element-by-element identical `{idx,octShift,vel}`. Full 32-generation raw row evolution also confirmed identical JS↔Python.
- **Known-value.** Rule 90 lone centre = Sierpinski triangle: gen1 live at offsets `[-1,+1]`, gen2 at `[-2,+2]` — verified. Rule 30 lone centre: gen1 three live at `[-1,0,+1]` — verified.
- **Non-degeneracy gate.** PASS: ≥3 distinct idx (5 for default rule 90), not all rests, not constant idx; chaotic rules 30/110 aperiodic over the run length (no period < length/2).
- **AC-8 (gate discriminates).** Degenerate `rule=0` (all cells die → reseed centre → die loop → collapses to a single idx / alternating rest) correctly **FAILS** the gate (distinct_idx=1). Cross-check still bit-identical for the degenerate config — determinism holds even when musically dead.
- **Distinct notes (default rule 90, pool len 5, len 32):** 5.

**Files.** `_arp_styles_src/automaton.js` (standalone, self-registers) · `_arp_styles_src/automaton_ref.py` (Python oracle, mulberry32 32-bit-masked) · registered as `STYLES.automaton` in `arp-styles.js`.

---

## VERIFICATION REPORT — `logistic` (LOGISTIC) · VERIFIED 2026-06-30

- **Source:** `_arp_styles_src/logistic.js` (JS gen) + `_arp_styles_src/logistic_ref.py` (Python ref). `node --check` PASS, `ast.parse` PASS. No RNG — orbit is fully deterministic from a fixed `x0`, so determinism is structural (seed ignored).
- **Math:** 1-D logistic map `x_{n+1} = r·x_n·(1−x_n)`. From fixed `x0`, discard **SETTLE=200** transient, then one note per iteration. Single `float64` `x`, identical recurrence + op order both languages (no numpy in `gen`).
- **Mapping:** `xc=clamp(x,0,1)`; `idx=clampInt(floor(xc·L),0,L−1)`; `octShift=clampInt(floor(xc·(2·octSpan+1))−octSpan, ±(octaves−1))`; `vel = velMode==='fromX' ? clampInt(40+floor(xc·87),1,127) : 96`; never null.
- **Params:** `r`(float 2.4–4.0, default 3.9) · `x0`(float 0.01–0.99, default 0.5) · `velMode`(enum {fromX,fixed}, default fromX) · `octSpan`(int 0–2, default 1).
- **Cross-check (PASS — identical):** canonical pool `[60,62,64,67,69]` (L=5), opts `{length:64, seed:1994, octaves:3, r:3.9, x0:0.5, velMode:fromX, octSpan:1}` → JS array (registry `window.ARP_STYLES.logistic.gen`, run under Node) == Python ref element-by-element on (idx/octShift/vel), **0 mismatches over 64 steps**. Reproduced by `_arp_styles_src/verify_all.py` (line: `logistic PASS identical=True`). Bit-exactness from identical IEEE-754 doubles + identical `Math.floor`/clamp quantization.
- **Known-value assertion — Lyapunov (oracle):** `λ = mean(log|r(1−2x)|)` over 200k post-settle iterations: **λ(r=3.9) = +0.4949 > 0** ⇒ sensitive dependence ⇒ genuinely aperiodic chaos (matches the spec requirement "map Lyapunov > 0" at r=3.9, x0=0.5 chosen to avoid the absorbing-0 trap). Contrast **λ(r=3.2) = −0.9163 < 0** ⇒ period-2 attractor (the AC-8 degenerate).
- **Non-degeneracy gate (PASS, L=5):** default r=3.9 → distinct idx = 5 (≥3); not-all-rest; non-constant; aperiodic (λ>0).
- **AC-8 discrimination (PASS):** degenerate config `r=3.2` → period-2 → exactly **2 distinct idx** → gate **FAILS** (`<3 distinct`). The `r` knob IS the live order→chaos morph; cross-check on the degenerate config also identical JS↔Python.
- **Verdict: PASS.**

---

## VERIFICATION REPORT — `collatz` (COLLATZ) · VERIFIED 2026-06-30

- **Source:** `_arp_styles_src/collatz.js` (JS gen) + `_arp_styles_src/collatz_ref.py` (Python ref). `node --check` PASS, `ast.parse` PASS. Pure integer (no floats ⇒ no IEEE-754 risk). No randomness — seed param is the hailstone start, not RNG; determinism is structural.
- **Math:** hailstone of seed `s>0`: `h=s`; while `h≠1`: append `h`, then `h = h//2` (even) or `3h+1` (odd); finally append `1`. Fill `length`: shorter + `restart_on_one` → wrap from `s`; shorter + off → pad tail with `idx=null` rests; longer → truncate.
- **Mapping:** `idx=pmod(h,L)`; `octShift=clampInt(+1 if h odd else −1, ±(octaves−1))` (odd rises like 3n+1, even falls like n/2); `vel=clampInt(60+pmod(h,60),1,127)` → 60..119.
- **Params:** `seed`(int 1–200, default 27) · `restart_on_one`(bool, default true).
- **Cross-check (PASS — identical):** canonical pool `[60,62,64,67,69]` (L=5), opts `{length:64, seed:1994, octaves:3, ...defaults}` where the style `seed` param default (27) overrides the universal seed per the contract → JS array == Python ref element-by-element on (idx/octShift/vel), **0 mismatches over 64 steps**. Reproduced by `verify_all.py` (`collatz PASS identical=True`).
- **Known-value assertions (PASS):** `hailstone(6) = [6,3,10,5,16,8,4,2,1]` (len 9) ✓; `hailstone(7) = [7,22,11,34,17,52,26,13,40,20,10,5,16,8,4,2,1]` (len 17) ✓ — both exact in JS and Python. **`len(traj(6))=9 ≠ len(traj(7))=17`** ⇒ phrase length is a genuine per-seed instrument (the spec's "phrase length varies by seed").
- **Non-degeneracy gate (PASS, L=5):** default seed=27 → distinct idx = 5 (≥3); not-all-rest; non-constant; always resolves home to 1.
- **AC-8 discrimination (PASS):** degenerate config pool `L=1` → every `idx = h%1 = 0` → **1 distinct idx** → gate **FAILS** (`<3 distinct`, constant). Cross-check on the degenerate config also identical JS↔Python. Healthy passes, degenerate fails ⇒ gate discriminates.
- **Verdict: PASS.**

---

## VERIFICATION REPORT — `pink` (PINK 1/F) · VERIFIED 2026-06-30

- **Source:** `_arp_styles_src/pink.js` (JS gen) + `_arp_styles_src/pink_ref.py` (Python ref, mulberry32 32-bit-masked `&0xFFFFFFFF`). `node --check` PASS, `ast.parse` PASS. All randomness via the shared bit-exact mulberry32 — determinism via fixed seed.
- **Math:** Voss-McCartney 1/f. `K=octaves` summed sources. n=0: all `rows[0..K−1]=rng()` (K draws); n>0: redraw `rows[0..min(trailing-zeros(n),K−1)]`; then one white-jitter `j=rng()`; `pink[n]=(Σrows+j)/(K+1) ∈ [0,1)`. If `restProb>0` an extra `rr=rng()` draws AFTER value+jitter (documented in ref) so the stream stays in lock-step.
- **Mapping:** `idx=pmod(floor(p·L),L)`; `octShift = +1 if p>hi, −1 if p<lo, else 0` clamped ±(octaves−1); `d=|p−pprev|`; `vel=clampInt(round(48+79·(0.35·p+0.65·min(1,d·4))),1,127)`. JS `Math.round` mirrored in Python as `floor(x+0.5)` (vel arg ≥0 always).
- **Params:** `octaves`(int 2–8, default 5 — UI-labelled **'sources (K)'**, # summed noise sources / noise color, NOT register) · `seed`(int, default 1) · `restProb`(float 0–0.4, default 0) · `hi`(float, default 0.88) · `lo`(float, default 0.12).
- **Cross-check (PASS — identical):** canonical pool `[60,62,64,67,69]` (L=5), opts `{length:64, octaves:5, seed:1, restProb:0, hi:0.88, lo:0.12}` (style `seed`+`octaves` param defaults override universals per contract) → JS array == Python ref element-by-element on (idx/octShift/vel), **0 mismatches over 64 steps**. Reproduced by `verify_all.py` (`pink PASS identical=True`). Also confirmed identical at seeds 1994 / 12345 directly.
- **Non-degeneracy gate (PASS, L=5):** default K=5 → distinct idx = 3 (≥3); not-all-rest; non-constant.
- **AC-8 — SPECTRAL discriminator (PASS, the highest-leverage gap, now recorded):** distinct-idx CANNOT discriminate pink (degenerate K=1 white control yields **5** distinct idx vs healthy K=5's **3** — *more*, not fewer). The discriminator is the FFT log-log power-spectrum slope fit on the continuous `pink[n]` series (length 4096, default seed, reconstructed via the same Voss-McCartney draw order as the ref):
  - **pink (K=5): slope = −0.68** — inside the required band `[−1.6, −0.4]` (true 1/f signature). ✓
  - **white control (K=1): slope = −0.05** — ≈0, FAILS the `slope ≤ −0.4` band. ✓
  - pink slope is strictly more-negative than white (`−0.68 < −0.05`). ✓
  ⇒ the **spectral** gate (not distinct-idx) is what makes the degenerate K=1 case fail. Committed + reproducible in `verify_all.py::pink_spectral_check()` (numpy used in the verification oracle ONLY — never inside `gen`).
- **Verdict: PASS.**

---

## CROSS-CHECK HARNESS (committed, reproducible) · 2026-06-30

The JS↔Python identical-output evidence above is no longer asserted only in prose — it is regenerated by a committed harness so any reviewer can reproduce the PASS:

- **`_arp_styles_src/verify_all_runner.js`** — headless Node side. Loads `../arp-styles.js` (the single source of the 9 gens), runs `_selfTest` (StepObject-contract assertion over every gen), and emits each style's program as JSON on the canonical inputs. `node verify_all_runner.js <key>` prints one style; no arg prints all + selfTest.
- **`_arp_styles_src/verify_all.py`** — Python side. For each of the 9 styles: runs `<key>_ref.gen`, shells `node verify_all_runner.js <key>`, diffs element-by-element on (idx, octShift, vel), runs the ≥3-distinct spot check, then the pink spectral discriminator. Exit 0 = all 9 byte-identical + selfTest ok + spectral pass.
- **Canonical inputs:** `pool=[60,62,64,67,69]` (L=5), `opts={length:64, seed:1994, octaves:3, ...each style's param defaults}`. Style param defaults are applied LAST, so a param colliding with a universal key (collatz `seed`→27, pink `seed`→1 + `octaves`→5) overrides it — identical on both sides.
- **Last run (2026-06-30):** `node _selfTest: {ok:True, styles:9}` · all 9 `PASS identical=True` · `pink spectral PASS {pink_K5_slope:−0.68, white_K1_slope:−0.05}` · **`ALL 9 PASS (JS==Python, reproducible)`** exit 0.
- **Contract tightening (vel on rests):** the `arp-styles.js` header now explicitly allows `vel:0` (or omitted) on rest steps (`idx===null`); both consumers (`applyArpStyle` in `arpeggiator.html` + `firestarter-core.js`) key solely off `idx===null` and never read `vel` on a rest, so the strict `[1,127]` range applies only to sounding steps. No functional change — spec-vs-implementation tightening. The `_selfTest` enforces this (skips octShift/vel checks on rests).
- **Ref name uniformity:** `golden_ref.py` now exposes `gen(pool_len, opts)` (with `gen_golden` kept as a back-compat alias); all 9 refs honor the identical `gen()` contract so the single harness iterates them uniformly.
