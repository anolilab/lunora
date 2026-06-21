import { Audio } from "@remotion/media";
import { AbsoluteFill, interpolate, Sequence, staticFile } from "remotion";

import { Background } from "../shared/background";
import { fontVars } from "../shared/fonts";
import { Outro } from "../shared/outro";
import { Stage } from "../shared/stage";
import { BRAND } from "../shared/theme";
import { CodeScene } from "./code-scene";
import { FUNCTIONS_CODE, SCALE_CODE, SCHEMA_CODE } from "./code";
import { FrameworksScene } from "./frameworks-scene";
import { InstallScene } from "./install-scene";
import { KineticIntro } from "./kinetic-intro";
import { ReactiveScene } from "./reactive-scene";
import { beatsToFrames, TIMING } from "./timings";

// Soundtrack dynamics: hold a full bed, then duck under moments that carry their
// own sound — terminal typing (install), the code scenes, and the chat
// composer + message pings (reactive) — so those SFX read clearly. Ramped over
// 10 frames in/out so each dip is felt, not heard as a cut.
const BED = 0.85;

const rampDuck = (frame: number, from: number, to: number, lo: number): number => {
    const inR = interpolate(frame, [from, from + 10], [BED, lo], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const outR = interpolate(frame, [to - 10, to], [lo, BED], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return Math.min(inR, outR);
};

const themeVolume = (frame: number): number => {
    // Whole-scene ducks where the scene has its own audio/focus.
    for (const id of ["install", "schema", "functions", "scale"] as const) {
        const { from, duration } = TIMING[id];
        if (frame >= from && frame < from + duration) return rampDuck(frame, from, from + duration, 0.6);
    }
    // Reactive: cover the composer typing through both pings (local beats 2 → 8).
    const r = TIMING.reactive;
    const rStart = r.from + beatsToFrames(2) - 6;
    const rEnd = r.from + beatsToFrames(8) + 18;
    if (frame >= rStart && frame < rEnd) return rampDuck(frame, rStart, rEnd, 0.6);

    return BED;
};

/** A scene: just content in a Stage. The clean backdrop is constant at the root. */
const Scene: React.FC<{
    id: keyof typeof TIMING;
    children: React.ReactNode;
}> = ({ id, children }) => {
    const { from, duration } = TIMING[id];
    return (
        <Sequence from={from} durationInFrames={duration} layout="none">
            <Stage durationInFrames={duration}>{children}</Stage>
        </Sequence>
    );
};

export const LunoraLaunch: React.FC = () => (
    <AbsoluteFill style={{ background: BRAND.base, ...fontVars }}>
        <Audio src={staticFile("audio/launch-theme.mp3")} volume={themeVolume} />
        <Background />

        <Scene id="kinetic">
            <KineticIntro />
        </Scene>

        <Scene id="install">
            <InstallScene />
        </Scene>

        <Scene id="schema">
            <CodeScene title="One file. Your whole data model — typed." filename="lunora/schema.ts" code={SCHEMA_CODE} height={520} />
        </Scene>

        <Scene id="functions">
            <CodeScene title="Queries & mutations. Typed end-to-end." filename="lunora/messages.ts" code={FUNCTIONS_CODE} height={620} />
        </Scene>

        <Scene id="reactive">
            <ReactiveScene />
        </Scene>

        <Scene id="scale">
            <CodeScene title="Outgrow one node? Opt in. No rewrite." filename="lunora/schema.ts" code={SCALE_CODE} height={470} />
        </Scene>

        <Scene id="frameworks">
            <FrameworksScene />
        </Scene>

        <Scene id="outro">
            <Outro />
        </Scene>
    </AbsoluteFill>
);
