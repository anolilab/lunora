import { AbsoluteFill } from "remotion";

import { Background } from "../shared/background";
import { CodeBlock } from "../shared/code-block";
import { fontVars } from "../shared/fonts";

/**
 * A still-only code card: the same {@link Background} + {@link CodeBlock} chrome the
 * launch video uses, centered full-frame, so social code cards match the video
 * exactly (monochrome, sharp window, no traffic-light dots). The window height is
 * derived from the line count so it sits snug at any snippet length.
 *
 * Rendered as a still, not played — render at a frame past the line-reveal stagger
 * (see `render:cards` in package.json) so every line is fully shown.
 */
export const CodeCard: React.FC<{
    filename: string;
    code: string;
    fontSize?: number;
}> = ({ filename, code, fontSize = 26 }) => {
    const lines = code.split("\n").length;
    // line height 1.55 + title bar (46) + vertical padding (60) + a little breathing room
    const height = Math.ceil(lines * fontSize * 1.55) + 46 + 60 + 12;

    return (
        <AbsoluteFill style={fontVars}>
            <Background />
            <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
                <CodeBlock code={code} filename={filename} fontSize={fontSize} height={height} width={1180} />
            </AbsoluteFill>
        </AbsoluteFill>
    );
};
