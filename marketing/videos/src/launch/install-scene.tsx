import { AbsoluteFill } from "remotion";

import { useFormat } from "../shared/format";
import { SceneLabel } from "../shared/scene-label";
import { Terminal } from "../shared/terminal";
import type { TermLine } from "../shared/terminal";

// Mirrors the real `pnpm dev` output (Vite + the Cloudflare plugin running
// workerd), incl. the `__lunora` studio route. Ready time shown snappy for the
// teaser rather than a cold first-boot.
const LINES: TermLine[] = [
    { text: "pnpm dlx lunorash init my-app", kind: "command" },
    { text: "✓ scaffolded my-app", kind: "success" },
    { text: "cd my-app && pnpm dev", kind: "command" },
    { text: "VITE v8.0.16  ready in 412 ms", kind: "log" },
    { text: "➜  Local:    http://localhost:5173/", kind: "log" },
    { text: "➜  Lunora:   http://localhost:5173/__lunora", kind: "success" },
    { text: "➜  runs on workerd — your Cloudflare, for real", kind: "log" },
];

export const InstallScene: React.FC = () => {
    const { fitWidth, pick } = useFormat();

    return (
        <AbsoluteFill>
            <SceneLabel title="One command. A live backend." />
            <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", top: pick(60, 0) }}>
                <Terminal label="~/my-app" lines={LINES} width={fitWidth(1000)} height={460} fontSize={pick(22, 20)} />
            </AbsoluteFill>
        </AbsoluteFill>
    );
};
