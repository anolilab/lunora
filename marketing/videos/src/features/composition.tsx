import { Audio } from "@remotion/media";
import { AbsoluteFill, interpolate, Sequence, staticFile } from "remotion";

import { Background } from "../shared/background";
import { fontVars } from "../shared/fonts";
import { Outro } from "../shared/outro";
import { Stage } from "../shared/stage";
import { BRAND } from "../shared/theme";
import { CodeScene } from "../launch/code-scene";
import { AI_CODE, PAYMENTS_CODE, R2SQL_CODE, WORKFLOWS_CODE } from "./code";
import { CtxIntro } from "./ctx-intro";
import { TIMING } from "./timings";

// Same bed + duck approach as the launch: hold a full bed, then dip under the
// four code reveals so each snippet reads in quiet focus. Ramped 10 frames in/out
// so each dip is felt, not heard as a cut.
const BED = 0.85;

const rampDuck = (frame: number, from: number, to: number, lo: number): number => {
    const inR = interpolate(frame, [from, from + 10], [BED, lo], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const outR = interpolate(frame, [to - 10, to], [lo, BED], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return Math.min(inR, outR);
};

const themeVolume = (frame: number): number => {
    for (const id of ["ai", "payments", "workflows", "r2sql"] as const) {
        const { from, duration } = TIMING[id];
        if (frame >= from && frame < from + duration) return rampDuck(frame, from, from + duration, 0.6);
    }
    return BED;
};

/** A scene: content in a Stage. The clean backdrop is constant at the root. */
const Scene: React.FC<{ id: keyof typeof TIMING; children: React.ReactNode }> = ({ id, children }) => {
    const { from, duration } = TIMING[id];
    return (
        <Sequence from={from} durationInFrames={duration} layout="none">
            <Stage durationInFrames={duration}>{children}</Stage>
        </Sequence>
    );
};

/**
 * "Platform on ctx" — the features release video. The same monochrome teaser
 * language as the launch: a cold open lighting up the typed `ctx.*` primitive
 * grid into the brand reveal, then four spotlight beats (AI, payments,
 * workflows, R2 SQL), closed by the outro CTA.
 */
export const LunoraFeatures: React.FC = () => (
    <AbsoluteFill style={{ background: BRAND.base, ...fontVars }}>
        <Audio src={staticFile("audio/launch-theme.mp3")} volume={themeVolume} />
        <Background />

        <Scene id="kinetic">
            <CtxIntro />
        </Scene>

        <Scene id="ai">
            <CodeScene title="ctx.ai — Workers AI, no lock-in." filename="lunora/summarize.ts" code={AI_CODE} height={620} fontSize={23} />
        </Scene>

        <Scene id="payments">
            <CodeScene title="ctx.payments — Stripe, typed & synced." filename="lunora/billing.ts" code={PAYMENTS_CODE} height={620} fontSize={23} />
        </Scene>

        <Scene id="workflows">
            <CodeScene
                title="Durable workflows. Steps that survive restarts."
                filename="lunora/workflows.ts"
                code={WORKFLOWS_CODE}
                height={620}
                fontSize={23}
            />
        </Scene>

        <Scene id="r2sql">
            <CodeScene title="ctx.r2sql — analytics with window functions." filename="lunora/analytics.ts" code={R2SQL_CODE} height={660} fontSize={23} />
        </Scene>

        <Scene id="outro">
            <Outro tagline="The whole platform. Typed, real-time, yours." />
        </Scene>
    </AbsoluteFill>
);
