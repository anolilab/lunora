import { BEAT_OFFSET, beatsToFrames } from "../launch/timings";

/**
 * The features video rides the same soundtrack + beat grid as the launch
 * (`../launch/timings`) — we only redefine the scene set and lengths here so the
 * two videos share one cut grid locked to the track's kick. Frames are derived
 * from the shared {@link beatsToFrames} so every cut still lands on a beat.
 */
const DURATIONS_BEATS = {
    kinetic: 16, // grid pre-light (ctx.* primitives ignite on the beat) → brand reveal
    ai: 9, // ctx.ai
    payments: 9, // ctx.payments
    workflows: 10, // defineWorkflow — densest snippet, extra beat
    r2sql: 10, // ctx.r2sql window functions
    outro: 9,
} as const;

type SceneId = keyof typeof DURATIONS_BEATS;

const ORDER: SceneId[] = ["kinetic", "ai", "payments", "workflows", "r2sql", "outro"];

export const TIMING = (() => {
    const out = {} as Record<SceneId, { from: number; duration: number }>;
    let cumBeats = 0;
    for (const id of ORDER) {
        const from = BEAT_OFFSET + beatsToFrames(cumBeats);
        cumBeats += DURATIONS_BEATS[id];
        out[id] = { from, duration: beatsToFrames(cumBeats) - beatsToFrames(cumBeats - DURATIONS_BEATS[id]) };
    }
    return out;
})();

const TOTAL_BEATS = Object.values(DURATIONS_BEATS).reduce((s, b) => s + b, 0);
export const TOTAL_DURATION = BEAT_OFFSET + beatsToFrames(TOTAL_BEATS);
