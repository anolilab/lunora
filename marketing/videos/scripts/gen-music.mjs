/**
 * Generates `sources/audio/synth-fallback.wav` — an ORIGINAL, CC0 cinematic
 * teaser bed synthesized from scratch (no sampled or copyrighted material). A
 * fully rights-clean fallback to the licensed Pixabay track. 150 BPM, so every
 * scene cut (a multiple of 12 frames @ 30fps = a beat) lands on the beat.
 * Re-run with `node scripts/gen-music.mjs`. Output lands in `sources/` (raw,
 * un-bundled); copy/trim into `public/audio/` to actually ship it.
 *
 * Bold, "we-are-here" energy on an anthemic Am–F–C–G bed:
 *   0.0–4.8s  KINETIC  rising stabs (word-flashes) → riser → climax impact
 *   4.8–9.2   INSTALL  driving kick + claps (2&4) + eighth hats + bass
 *   9.2–18.0  CODE     pulled back: lighter kick + soft glass-bell arpeggio
 *   18.0–24.0 REACTIVE full drive + a bright bell PING on send (20.8s) & receive (21.2s)
 *   24.0–28.0 CODE     (scale) bell arpeggio
 *   28.0–32.0 OUTRO    big pad resolve + fade
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SR = 44100;
const BEAT = 0.4; // 150 BPM
const SECONDS = 33;
const N = Math.floor(SR * SECONDS);
const out = new Float64Array(N);

const sine = (f, t) => Math.sin(2 * Math.PI * f * t);
let seed = 0x9e3779b9 % 2147483647;
const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
};
const semis = (f, n) => f * 2 ** (n / 12);

// Am – F – C – G (anthem progression), one chord per 8 beats.
const CHORDS = [
    [110.0, 130.81, 164.81],
    [87.31, 110.0, 130.81],
    [130.81, 164.81, 196.0],
    [98.0, 123.47, 146.83],
];
const chordAt = (t) => CHORDS[Math.floor(t / (BEAT * 8)) % CHORDS.length];

// Section ranges (seconds) — match src/launch/timings.ts.
const R = { install: [4.8, 9.2], schema: [9.2, 13.2], functions: [13.2, 18.0], reactive: [18.0, 24.0], scale: [24.0, 28.0] };
const inR = (t, [a, b]) => t >= a && t < b;
const isCode = (t) => inR(t, R.schema) || inR(t, R.functions) || inR(t, R.scale);
const STEADY = 12 * BEAT; // 4.8s
const CLIMAX = 7 * BEAT; // 2.8s
const STAB_BEATS = [1, 2, 3, 4, 5];
const PINGS = [20.8, 21.2]; // reactive send & receive (on the beat)

for (let i = 0; i < N; i += 1) {
    const t = i / SR;
    let s = 0;

    // Sub drone.
    s += sine(42, t) * 0.1 * (0.7 + 0.3 * Math.sin(2 * Math.PI * 0.25 * t));

    // ── Intro: rising stabs ──
    for (let k = 0; k < STAB_BEATS.length; k += 1) {
        const dt = t - STAB_BEATS[k] * BEAT;
        if (dt >= 0 && dt < 0.4) {
            const f = semis(174.61, k);
            s += (sine(f, t) * 0.55 + sine(f * 2, t) * 0.25 + noise() * Math.exp(-dt * 50) * 0.6) * Math.exp(-dt * 8) * (0.45 + k * 0.05);
        }
    }
    // Riser into the reveal.
    if (t >= 2.4 && t < CLIMAX) {
        const u = (t - 2.4) / 0.4;
        s += noise() * u * u * 0.34;
    }
    // Climax impact + triumphant power chord onset (A, E, A').
    if (t >= CLIMAX) {
        const dt = t - CLIMAX;
        if (dt < 1.4) s += sine(80 * Math.exp(-dt * 4) + 40, dt) * Math.exp(-dt * 3) * 0.75;
        const atk = Math.min(1, dt / 0.5);
        for (const f of [110.0, 164.81, 220.0]) s += sine(f, t) * 0.02 * atk;
    }

    // ── Steady bed (feature scenes) — bold drive ──
    if (t >= STEADY) {
        const ch = chordAt(t);
        const code = isCode(t);
        const beatPhase = t % BEAT;
        const beatInBar = Math.floor(t / BEAT) % 4;

        // Warm pad.
        for (const f of ch) s += sine(f, t) * 0.02 + sine(f * 2, t) * 0.009;

        // Bass pulse on the root, every beat — presence.
        s += sine(ch[0] / 2, t) * Math.exp(-beatPhase * 9) * (code ? 0.12 : 0.2);

        // Punchy kick every beat.
        s += sine(110 * Math.exp(-beatPhase * 34) + 46, beatPhase) * Math.exp(-beatPhase * 15) * (code ? 0.16 : 0.44);

        // Clap on beats 2 & 4 (skip under code for calm).
        if (!code && (beatInBar === 1 || beatInBar === 3)) {
            s += noise() * Math.exp(-beatPhase * 26) * 0.2;
        }

        // Eighth-note hats for speed.
        const eb = t % (BEAT / 2);
        s += noise() * Math.exp(-eb * 120) * (code ? 0.02 : 0.05);

        // Soft glass-bell arpeggio under code — warm, melodic.
        if (code) {
            const step = Math.floor(t / BEAT);
            const pat = [0, 1, 2, 1];
            const f = ch[pat[step % pat.length]] * 4;
            const env = beatPhase < 0.015 ? beatPhase / 0.015 : Math.exp(-(beatPhase - 0.015) * 5);
            s += (sine(f, t) * 0.6 + sine(f * 2, t) * 0.22 + sine(f * 3, t) * 0.08) * env * 0.06;
        }
    }

    // Bright bell ping on the reactive send & receive (the message pop).
    for (const p of PINGS) {
        const dt = t - p;
        if (dt >= 0 && dt < 0.7) s += (sine(988, t) + 0.5 * sine(1480, t)) * Math.exp(-dt * 6) * 0.2;
    }

    out[i] = s;
}

// Master: soft clip → fades → normalize.
let peak = 0;
for (let i = 0; i < N; i += 1) {
    out[i] = Math.tanh(out[i] * 1.05);
    const t = i / SR;
    out[i] *= Math.max(0, Math.min(Math.min(1, t / 0.3), Math.min(1, (SECONDS - t) / 2.2)));
    peak = Math.max(peak, Math.abs(out[i]));
}
const gain = peak > 0 ? 0.95 / peak : 1;

const dataSize = N * 2;
const buffer = Buffer.alloc(44 + dataSize);
buffer.write("RIFF", 0);
buffer.writeUInt32LE(36 + dataSize, 4);
buffer.write("WAVE", 8);
buffer.write("fmt ", 12);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(1, 22);
buffer.writeUInt32LE(SR, 24);
buffer.writeUInt32LE(SR * 2, 28);
buffer.writeUInt16LE(2, 32);
buffer.writeUInt16LE(16, 34);
buffer.write("data", 36);
buffer.writeUInt32LE(dataSize, 40);
for (let i = 0; i < N; i += 1) {
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[i] * gain)) * 32767), 44 + i * 2);
}

writeFileSync(fileURLToPath(new URL("../sources/audio/synth-fallback.wav", import.meta.url)), buffer);
console.log("wrote sources/audio/synth-fallback.wav — 150 BPM, bold drive, ping on reactive beats");
