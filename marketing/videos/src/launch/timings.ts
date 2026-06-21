export const FPS = 30;

/**
 * Tempo of the soundtrack (`public/audio/launch-theme.mp3`, a section of a Pixabay track
 * by audioknap, Pixabay Content License — free for commercial use, no
 * attribution required). The felt beat is the KICK pulse ≈121.75 BPM (a
 * low-pass onset analysis; a full-spectrum estimate mis-locked at ~91). The cut
 * grid is locked to the kick so cuts/word-flashes land on the beat you hear.
 */
export const BPM = 121.75;
/** Frames per beat (float). Beat-aligned frames are rounded at each boundary. */
export const BEAT_FRAMES = (60 / BPM) * FPS;

/**
 * The track plays from 0:00, but its first downbeat sits ~0.3s in, so the whole
 * cut grid is shifted by this lead-in to land scene boundaries on the track's
 * beats. Frames 0–OFFSET are a brief black hold (anticipation) before the open.
 */
export const BEAT_OFFSET = Math.round(0.3 * FPS); // ≈9 frames

/** Round a beat count to a frame number on the (local) grid — no offset. */
export const beatsToFrames = (beats: number): number => Math.round(beats * BEAT_FRAMES);

/**
 * Scene lengths in BEATS. Frames are derived from {@link BEAT_FRAMES} so cuts
 * snap to the track's beats. Total = 60 beats ≈ 34s.
 */
// Beats per scene. At ~122 BPM a beat is ~0.49s, so code scenes get extra beats
// to stay readable. Total ≈ 75 beats ≈ 37s.
const DURATIONS_BEATS = {
    kinetic: 12, // word flashes (beats 1-5) → reveal (beat 6) → hold
    install: 8,
    schema: 8,
    functions: 10, // densest snippet — extra beat so it stays readable
    reactive: 12,
    scale: 8,
    frameworks: 8, // "every framework" perspective marquee
    outro: 9,
} as const;

type SceneId = keyof typeof DURATIONS_BEATS;

const ORDER: SceneId[] = ["kinetic", "install", "schema", "functions", "reactive", "scale", "frameworks", "outro"];

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
