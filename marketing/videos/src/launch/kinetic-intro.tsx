import { AbsoluteFill, Easing, interpolate, Sequence, useCurrentFrame } from "remotion";

import { BuiltForCloudflare } from "../shared/built-for-cloudflare";
import { useFormat } from "../shared/format";
import { FONT_SANS } from "../shared/fonts";
import { LunoraMark } from "../shared/lunora-mark";
import { BRAND, COPY } from "../shared/theme";
import { BEAT_FRAMES, beatsToFrames } from "./timings";
import { Wordmark } from "../shared/wordmark";

const EASE = Easing.out(Easing.cubic);

const REVEAL_AT = beatsToFrames(6); // wordmark reveal on beat 6

/** Hard-cut word flashes, one per beat (beats 1-5), landing on the track's beats. */
const FlashWords: React.FC = () => {
    const frame = useCurrentFrame();
    const { width, pick } = useFormat();
    const beatIndex = Math.floor(frame / BEAT_FRAMES);
    const i = beatIndex - 1; // beat 1 → first word
    if (i < 0 || i >= COPY.kinetic.length) return null;

    const phase = frame - beatIndex * BEAT_FRAMES;
    // HARD CUT on the beat: full presence on frame 0 of the beat, a tiny fast
    // scale settle (3 frames) for a "hit", then hold — the next word hard-cuts in
    // exactly on the following beat. Nothing trails after the beat.
    const appear = phase < 1 ? phase : 1;
    const scale = interpolate(phase, [0, 3], [1.08, 1], { easing: EASE, extrapolateRight: "clamp" });

    return (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
            <span
                style={{
                    color: BRAND.ink,
                    fontFamily: FONT_SANS,
                    // Scale down on narrow cuts; cap width so the longest word never clips.
                    fontSize: pick(132, 84, 104),
                    fontWeight: 600,
                    letterSpacing: -3,
                    lineHeight: 1,
                    maxWidth: width * 0.9,
                    opacity: appear,
                    textAlign: "center",
                    transform: `scale(${scale})`,
                    willChange: "transform, opacity",
                }}
            >
                {COPY.kinetic[i]}
            </span>
        </AbsoluteFill>
    );
};

/**
 * One reusable fade-up: opacity + a small `translateY`, both animated via
 * transform/opacity only — never layout — so siblings never reflow (no jump).
 * Every child reserves its space from frame 0; only its appearance animates.
 */
const FadeUp: React.FC<{ from: number; children: React.ReactNode; lift?: number }> = ({ from, children, lift = 12 }) => {
    const frame = useCurrentFrame();
    const t = interpolate(frame, [from, from + 22], [0, 1], { easing: EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return <div style={{ opacity: t, transform: `translateY(${(1 - t) * lift}px)`, willChange: "transform, opacity" }}>{children}</div>;
};

/** The climax reveal: moon mark → wordmark → tagline → Built-for-Cloudflare. */
const Reveal: React.FC = () => {
    const { pick } = useFormat();

    return (
        <AbsoluteFill style={{ alignItems: "center", flexDirection: "column", justifyContent: "center", gap: 24, padding: "0 40px" }}>
            <FadeUp from={0} lift={10}>
                {/* The deliberate single aurora moment — matches the outro mark. */}
                <div style={{ filter: BRAND.markGlow }}>
                    <LunoraMark size={pick(150, 120)} />
                </div>
            </FadeUp>
            <Wordmark fontSize={pick(140, 92, 110)} delay={8} />
            <FadeUp from={24}>
                <div style={{ color: BRAND.inkMuted, fontFamily: FONT_SANS, fontSize: pick(30, 24), letterSpacing: -0.3, textAlign: "center" }}>
                    {COPY.tagline}
                </div>
            </FadeUp>
            <FadeUp from={38}>
                <div style={{ marginTop: 12 }}>
                    <BuiltForCloudflare size={pick(22, 20)} />
                </div>
            </FadeUp>
        </AbsoluteFill>
    );
};

/**
 * The Apple-teaser cold open: fast white-on-black word flashes cut to the music
 * stabs, then a black breath, then the wordmark climax on the impact beat.
 */
export const KineticIntro: React.FC = () => {
    const frame = useCurrentFrame();
    return (
        <AbsoluteFill>
            {frame < REVEAL_AT - 5 && <FlashWords />}
            <Sequence from={REVEAL_AT} layout="none">
                <Reveal />
            </Sequence>
        </AbsoluteFill>
    );
};
