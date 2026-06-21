import { AbsoluteFill } from "remotion";

import { CodeBlock } from "../shared/code-block";
import { useFormat } from "../shared/format";
import { SceneLabel } from "../shared/scene-label";

/**
 * A feature scene: an eyebrow label over a centered Lunora code window (sharp,
 * hairline, mono). Used for the schema, functions, and scaling beats. The window
 * caps to the canvas and the font eases down on portrait/square cuts.
 */
export const CodeScene: React.FC<{
    title: string;
    filename: string;
    code: string;
    width?: number;
    height?: number;
    fontSize?: number;
}> = ({ title, filename, code, width = 1180, height = 560, fontSize = 26 }) => {
    const { fitWidth, pick } = useFormat();

    return (
        <AbsoluteFill>
            <SceneLabel title={title} />
            <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", top: pick(70, 0) }}>
                <CodeBlock filename={filename} code={code} width={fitWidth(width)} height={height} fontSize={pick(fontSize, fontSize - 4)} />
            </AbsoluteFill>
        </AbsoluteFill>
    );
};
