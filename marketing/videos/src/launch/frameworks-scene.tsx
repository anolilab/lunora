import { AbsoluteFill } from "remotion";

import { PerspectiveMarquee } from "../components/remocn/perspective-marquee";
import { useFormat } from "../shared/format";
import { SceneLabel } from "../shared/scene-label";
import { BRAND } from "../shared/theme";

// The frameworks Lunora actually ships adapters for (@lunora/react · vue ·
// svelte · solid · astro) plus the framework-agnostic client (@lunora/client).
const ROW_A = ["React", "Vue", "Svelte", "SolidJS", "Astro", "Vanilla JS"];
const ROW_B = ["Astro", "SolidJS", "Vue", "Vanilla JS", "React", "Svelte"];

/**
 * "One backend. Every framework." — two perspective marquees rolling in opposite
 * directions, listing the supported frameworks. Same typed client everywhere.
 */
export const FrameworksScene: React.FC = () => {
    const { pick } = useFormat();
    const fontSize = pick(96, 60, 74);
    const band = fontSize * 1.7;

    return (
        <AbsoluteFill>
            <SceneLabel title="One backend. Every framework." />
            <AbsoluteFill style={{ alignItems: "center", flexDirection: "column", gap: pick(28, 16), justifyContent: "center" }}>
                <div style={{ height: band, position: "relative", width: "100%" }}>
                    <PerspectiveMarquee items={ROW_A} fontSize={fontSize} pixelsPerFrame={2} rotateY={-24} />
                </div>
                <div style={{ height: band, position: "relative", width: "100%" }}>
                    <PerspectiveMarquee items={ROW_B} color={BRAND.inkMuted} fontSize={fontSize} pixelsPerFrame={-1.7} rotateY={-24} />
                </div>
            </AbsoluteFill>
        </AbsoluteFill>
    );
};
