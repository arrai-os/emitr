# FIRESTARTER → Ableton — Live MIDI Setup (macOS)

Goal: FIRESTARTER (browser) drives Ableton Live's instruments in real time, and Ableton's tempo
follows the app (app = clock master). Path: **browser → Web MIDI API → macOS IAC Driver → Ableton.**

Use **Chrome** (or another Chromium browser) — Web MIDI is not available in Safari/Firefox.

---

## A. Create the IAC virtual MIDI bus (one-time)

1. Open **Audio MIDI Setup** (`/Applications/Utilities/Audio MIDI Setup.app`).
2. Menu bar → **Window → Show MIDI Studio**.
3. Double-click the **IAC Driver** icon.
4. Check **"Device is online."**
5. Under **Ports**, make sure a port named **"Bus 1"** exists. If not, click **+** to add one.
6. Click **Apply**, then close the window.

---

## B. Point Ableton's MIDI input at the bus

7. Open **Ableton Live → Settings → Link/Tempo/MIDI** (Live 11/12) or **Preferences → MIDI Sync** (Live 10).
8. Under **MIDI Ports**, find the **input** row **"IAC Driver (Bus 1)"** and turn on:
   - **Track = On** (lets MIDI notes play instruments)
   - **Sync = On** (lets the app's MIDI clock drive Live's tempo)
   - **Remote** can stay Off unless you map controls.

---

## C. Make Ableton follow the app's clock (EXT sync)

9. With **Sync = On** for the IAC input, Live shows an **`EXT`** button at the top-left (next to the tempo).
   Click **`EXT`** so Live follows the external (app) clock.
10. Turn **Ableton Link OFF** — Link and EXT clock conflict. (Link toggle is top-left; make sure it is not lit.)

> When FIRESTARTER is playing with Clock enabled, Live's tempo display will lock to the app's BPM
> even before the first note — the app emits MIDI clock continuously.

---

## D. Create a track to hear the app

**Option 1 — one track, all channels (simplest):**
11. Create a **MIDI track** (`⌘⇧T`).
12. **MIDI From → IAC Driver (Bus 1)**, channel **All**.
13. **Monitor → In.**
14. Drop a **Drum Rack** (for drums on MIDI ch 10) or an instrument on it and **arm** the track (record-enable).

**Option 2 — split drums and arp (recommended for production):**
11. **Track 1 (drums):** MIDI From → IAC Driver (Bus 1), channel **Ch. 10**, Monitor = In, load a Drum Rack, arm it.
12. **Track 2 (arp):** MIDI From → IAC Driver (Bus 1), channel **Ch. 1**, Monitor = In, load a synth, arm it.

FIRESTARTER sends drums on **channel 10** (GM drum map: kick 36, snare 38, clap 39, closed hat 42, …)
and the arp on **channel 1** by default. Channel numbers are editable in the app's MIDI strip.

---

## E. Go live in FIRESTARTER

15. In FIRESTARTER, click **ENABLE MIDI** (this is the required user gesture; the browser will ask for
    MIDI permission — allow it). The button relabels to **MIDI ✓**.
16. In the **output dropdown**, pick **IAC Driver (Bus 1)** (the app auto-selects the first port whose name
    contains "IAC").
17. Hit **PLAY**. Live's tempo jumps to the app's BPM, the playhead sweeps, and the pads trigger Live's
    instruments.

---

## F. Record the jam into Ableton

18. To capture, arm a **Session clip slot** (or switch to Arrangement and record) on the armed track(s)
    and hit Live's record. You're now recording the app's live MIDI as a normal Live clip.
19. Alternatively, use FIRESTARTER's **EXPORT** to drag a `.mid` of the drum pattern, the arp clip, or the
    full scene straight into a Live track — no MIDI routing needed for that path.

---

## G. Troubleshooting

| Symptom | Fix |
|---|---|
| **No sound in Live** | Track **Monitor = In** AND track **armed** (record-enabled). Instrument loaded. |
| **Tempo not following the app** | Confirm **`EXT`** is lit and **Link is OFF**. Confirm **Sync = On** for the IAC input. |
| **Double / stuck notes** | Don't set a single "All channels" track AND per-channel tracks at once — pick Option 1 *or* Option 2. |
| **No "ENABLE MIDI" success** | Use Chrome. Web MIDI is unavailable in Safari/Firefox. If denied, reset site permissions and retry. |
| **No IAC option in Live** | Re-check Audio MIDI Setup: IAC "Device is online" + "Bus 1" port exists. Restart Live after enabling. |
| **MIDI feels late vs the app's own sound** | This shouldn't happen — the sink calibrates `performance.now() − AudioContext.currentTime`. If it does, toggle ENABLE MIDI off/on to re-capture the offset. |
| **Drums on wrong sounds** | The app uses the GM drum map on ch 10. Use a Drum Rack mapped to GM notes (kick 36, snare 38, etc.) or remap pads. |
