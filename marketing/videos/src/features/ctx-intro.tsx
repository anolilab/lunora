import { AbsoluteFill, Easing, interpolate, Sequence, useCurrentFrame } from "remotion";

import { BuiltForCloudflare } from "../shared/built-for-cloudflare";
import { useFormat } from "../shared/format";
import { FONT_MONO, FONT_SANS } from "../shared/fonts";
import { LunoraMark } from "../shared/lunora-mark";
import { BRAND } from "../shared/theme";
import { Wordmark } from "../shared/wordmark";
import { beatsToFrames, BEAT_FRAMES } from "../launch/timings";

const EASE = Easing.out(Easing.cubic);

/** Reveal lands on beat 9 — the grid is fully lit and held by then. */
const REVEAL_AT = beatsToFrames(9);

/**
 * Every `ctx.*` handle codegen can wire onto a function context — the whole
 * Cloudflare platform as one typed object. The four this video spotlights are
 * brightened; the rest establish the breadth. The opener lights them in a
 * diagonal sweep, one anti-diagonal per beat.
 */
const HANDLES: { name: string; spot?: boolean }[] = [
    { name: "ai", spot: true },
    { name: "payments", spot: true },
    { name: "workflows", spot: true },
    { name: "r2sql", spot: true },
    { name: "db" },
    { name: "sql" },
    { name: "vectors" },
    { name: "scheduler" },
    { name: "storage" },
    { name: "kv" },
    { name: "images" },
    { name: "analytics" },
    { name: "browser" },
    { name: "containers" },
    { name: "auth" },
    { name: "mail" },
];

const Cell: React.FC<{ name: string; spot: boolean; delay: number; fontSize: number }> = ({ name, spot, delay, fontSize }) => {
    const frame = useCurrentFrame();
    const t = interpolate(frame, [delay, delay + 14], [0, 1], { easing: EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    // Spotlight cells flare brighter for a beat as they land, then settle.
    const flare = spot ? interpolate(frame, [delay, delay + 9, delay + 28], [0, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;

    return (
        <div
            style={{
                alignItems: "center",
                background: spot ? BRAND.surfaceSoft : BRAND.surface,
                border: `1px solid ${spot ? BRAND.hairlineStrong : BRAND.hairline}`,
                boxShadow: flare > 0 ? `0 0 26px rgba(255, 255, 255, ${flare * 0.16})` : "none",
                display: "flex",
                fontFamily: FONT_MONO,
                fontSize,
                gap: 10,
                justifyContent: "center",
                opacity: t,
                padding: "0 8px",
                paddingBlock: fontSize * 0.7,
                transform: `translateY(${(1 - t) * 10}px)`,
                willChange: "transform, opacity",
            }}
        >
            <span style={{ background: spot ? BRAND.accent : BRAND.hairlineStrong, height: 6, width: 6 }} />
            <span>
                <span style={{ color: BRAND.inkFaint }}>ctx.</span>
                <span style={{ color: spot ? BRAND.ink : BRAND.inkMuted }}>{name}</span>
            </span>
        </div>
    );
};

/**
 * The grid pre-light: every `ctx.*` primitive igniting in a diagonal sweep, one
 * anti-diagonal per beat. As the reveal begins it recedes (dims + sinks back) so
 * the brand mark resolves OUT of the lit platform rather than cutting to it.
 */
const Grid: React.FC = () => {
    const frame = useCurrentFrame();
    const { pick } = useFormat();
    const cols = pick(4, 2);
    const fontSize = pick(28, 30, 26);
    const beat = Math.round(BEAT_FRAMES);

    // Recede under the reveal: fade most of the way out and sink back a touch.
    const recede = interpolate(frame, [REVEAL_AT - 4, REVEAL_AT + 18], [1, 0.1], { easing: EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const scale = interpolate(frame, [REVEAL_AT - 4, REVEAL_AT + 18], [1, 0.94], { easing: EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });

    // First half of the thesis, carried over the grid; the reveal lands the rest.
    const labelIn = interpolate(frame, [beat * 5, beat * 6], [0, 1], { easing: EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const labelOut = interpolate(frame, [REVEAL_AT - 6, REVEAL_AT], [1, 0], { easing: EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });

    return (
        <AbsoluteFill style={{ opacity: recede, transform: `scale(${scale})`, willChange: "transform, opacity" }}>
            <div
                style={{
                    color: BRAND.ink,
                    fontFamily: FONT_SANS,
                    fontSize: pick(40, 30),
                    fontWeight: 600,
                    left: 0,
                    letterSpacing: -1,
                    opacity: Math.min(labelIn, labelOut),
                    position: "absolute",
                    right: 0,
                    textAlign: "center",
                    top: pick(110, 150),
                }}
            >
                Every Cloudflare primitive.
            </div>
            <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", padding: pick("0 90px", "0 50px"), top: pick(40, 0) }}>
                <div style={{ display: "grid", gap: pick(16, 12), gridTemplateColumns: `repeat(${cols}, 1fr)`, maxWidth: 1500, width: "100%" }}>
                    {HANDLES.map((h, i) => {
                        const row = Math.floor(i / cols);
                        const col = i % cols;
                        // Diagonal sweep: cells on the same anti-diagonal land on the same beat.
                        return <Cell key={h.name} name={h.name} spot={Boolean(h.spot)} delay={(row + col) * beat} fontSize={fontSize} />;
                    })}
                </div>
            </AbsoluteFill>
        </AbsoluteFill>
    );
};

/** One reusable fade-up (opacity + small lift), transform/opacity only — no reflow. */
const FadeUp: React.FC<{ from: number; children: React.ReactNode; lift?: number }> = ({ from, children, lift = 12 }) => {
    const frame = useCurrentFrame();
    const t = interpolate(frame, [from, from + 22], [0, 1], { easing: EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return <div style={{ opacity: t, transform: `translateY(${(1 - t) * lift}px)`, willChange: "transform, opacity" }}>{children}</div>;
};

/** The climax: moon mark → wordmark → the thesis payoff → Built-for-Cloudflare. */
const Reveal: React.FC = () => {
    const { pick } = useFormat();

    return (
        <AbsoluteFill style={{ alignItems: "center", flexDirection: "column", justifyContent: "center", gap: 24, padding: "0 40px" }}>
            <FadeUp from={0} lift={10}>
                <div style={{ filter: BRAND.markGlow }}>
                    <LunoraMark size={pick(150, 120)} />
                </div>
            </FadeUp>
            <Wordmark fontSize={pick(140, 92, 110)} delay={8} />
            <FadeUp from={24}>
                <div style={{ color: BRAND.inkMuted, fontFamily: FONT_SANS, fontSize: pick(30, 24), letterSpacing: -0.3, textAlign: "center" }}>
                    One typed context.
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
 * The features cold open — distinct from the launch's word-flash intro: the full
 * `ctx.*` platform grid lights up in a diagonal sweep (one anti-diagonal per
 * beat), then recedes as the brand mark resolves out of it on the impact beat.
 */
export const CtxIntro: React.FC = () => (
    <AbsoluteFill>
        <Grid />
        <Sequence from={REVEAL_AT} layout="none">
            <Reveal />
        </Sequence>
    </AbsoluteFill>
);
