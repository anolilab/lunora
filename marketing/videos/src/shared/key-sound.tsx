import { Audio, Sequence, staticFile } from "remotion";

/**
 * Frames (local) at which each character of a typed string appears, given a
 * typing speed. Throttled by `minGap` so very fast typing doesn't turn the key
 * clicks into a buzz — at most one click per `minGap` frames, still locked to
 * the characters as they land.
 */
export const typeClickFrames = (length: number, cps: number, fps: number, minGap = 3): number[] => {
    const frames: number[] = [];
    let last = -Infinity;
    for (let k = 1; k <= length; k++) {
        const f = Math.round((k / cps) * fps);
        if (f - last >= minGap) {
            frames.push(f);
            last = f;
        }
    }
    return frames;
};

/**
 * Plays a short CC0 key-tick (`public/audio/sfx-key.wav`, Kenney interface
 * sounds) at each given local frame — one per keystroke, so the sound matches
 * the text typing out. Core `remotion` <Audio> (reliable for short SFX).
 */
export const KeyClicks: React.FC<{ frames: number[]; volume?: number }> = ({ frames, volume = 0.7 }) => (
    <>
        {frames.map((f) => (
            <Sequence key={f} from={f} durationInFrames={2} layout="none">
                <Audio src={staticFile("audio/sfx-key.wav")} volume={volume} />
            </Sequence>
        ))}
    </>
);
