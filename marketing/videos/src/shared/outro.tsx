import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

import { BuiltForCloudflare } from "./built-for-cloudflare";
import { useFormat } from "./format";
import { FONT_MONO, FONT_SANS } from "./fonts";
import { LunoraMark } from "./lunora-mark";
import { BRAND, COPY } from "./theme";
import { Wordmark } from "./wordmark";

const EASE = Easing.out(Easing.cubic);

export const Outro: React.FC<{ tagline?: string }> = ({ tagline = COPY.outroTagline }) => {
    const frame = useCurrentFrame();
    const { pick } = useFormat();

    const reveal = interpolate(frame, [0, 20], [0, 1], { easing: EASE, extrapolateRight: "clamp" });
    const lift = interpolate(frame, [0, 20], [12, 0], { easing: EASE, extrapolateRight: "clamp" });
    const taglineReveal = interpolate(frame, [16, 36], [0, 1], { easing: EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const ctaReveal = interpolate(frame, [26, 46], [0, 1], { easing: EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const linksReveal = interpolate(frame, [40, 60], [0, 1], { easing: EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });

    return (
        <AbsoluteFill
            style={{
                alignItems: "center",
                flexDirection: "column",
                fontFamily: FONT_SANS,
                justifyContent: "center",
                gap: 26,
                opacity: reveal,
                padding: "0 40px",
                transform: `translateY(${lift}px)`,
            }}
        >
            {/* The deliberate single aurora moment — matches the kinetic reveal. */}
            <div style={{ filter: BRAND.markGlow }}>
                <LunoraMark size={pick(140, 120)} />
            </div>

            <Wordmark fontSize={pick(118, 92, 104)} delay={6} />

            <div style={{ color: BRAND.inkMuted, fontSize: pick(28, 24), letterSpacing: -0.4, opacity: taglineReveal, textAlign: "center" }}>{tagline}</div>

            <div style={{ marginTop: 6, opacity: taglineReveal }}>
                <BuiltForCloudflare size={pick(20, 18)} />
            </div>

            {/* Call to action — the first concrete step, as a copy-ready command pill. */}
            <div
                style={{
                    alignItems: "center",
                    background: BRAND.surface,
                    border: `1px solid ${BRAND.hairlineStrong}`,
                    color: BRAND.ink,
                    display: "flex",
                    fontFamily: FONT_MONO,
                    fontSize: pick(24, 21),
                    gap: 12,
                    marginTop: 18,
                    opacity: ctaReveal,
                    padding: "14px 24px",
                }}
            >
                <span style={{ color: BRAND.inkFaint }}>$</span>
                <span>{COPY.cta}</span>
            </div>

            <div
                style={{
                    alignItems: "center",
                    color: BRAND.inkFaint,
                    display: "flex",
                    fontFamily: FONT_MONO,
                    fontSize: pick(21, 18),
                    gap: 0,
                    marginTop: 8,
                    opacity: linksReveal,
                    textTransform: "uppercase",
                    letterSpacing: 1,
                }}
            >
                <span style={{ borderRight: `1px solid ${BRAND.hairlineStrong}`, color: BRAND.inkMuted, padding: "0 22px" }}>{COPY.repo}</span>
                <span style={{ color: BRAND.inkMuted, padding: "0 22px" }}>{COPY.domain}</span>
            </div>
        </AbsoluteFill>
    );
};
