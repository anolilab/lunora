import { Easing, interpolate, Sequence, useCurrentFrame, useVideoConfig } from "remotion";

import { FONT_MONO } from "./fonts";
import { KeyClicks, typeClickFrames } from "./key-sound";
import { Window } from "./window";
import { BRAND } from "./theme";

export type TermKind = "command" | "log" | "success";

export interface TermLine {
    text: string;
    kind: TermKind;
}

const KIND_COLOR: Record<TermKind, string> = {
    command: BRAND.ink,
    log: BRAND.inkMuted,
    success: "#5BD6A6",
};

const Row: React.FC<{ line: TermLine; cps: number }> = ({ line, cps }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();

    // Commands type out; logs/success fade in whole (percussive, ease-out).
    const typed = line.kind === "command" ? line.text.slice(0, Math.floor((frame / fps) * cps)) : line.text;
    const opacity =
        line.kind === "command"
            ? 1
            : interpolate(frame, [0, 6], [0, 1], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const typing = line.kind === "command" && typed.length < line.text.length;
    const caretOn = typing && Math.floor(frame / 8) % 2 === 0;
    // One key-click per character as the command types out (throttled so fast
    // typing doesn't buzz), synced to the characters appearing.
    const clickFrames = line.kind === "command" ? typeClickFrames(line.text.length, cps, fps) : [];

    return (
        <div style={{ display: "flex", gap: 12, opacity, whiteSpace: "pre" }}>
            {clickFrames.length > 0 && <KeyClicks frames={clickFrames} volume={0.7} />}
            <span style={{ color: line.kind === "command" ? BRAND.accent : "transparent", width: 14 }}>{line.kind === "command" ? "$" : " "}</span>
            <span style={{ color: KIND_COLOR[line.kind] }}>
                {typed}
                {caretOn && (
                    <span style={{ background: BRAND.accent, display: "inline-block", height: 20, marginLeft: 2, transform: "translateY(3px)", width: 9 }} />
                )}
            </span>
        </div>
    );
};

/**
 * A Lunora terminal: the sharp/hairline {@link Window} chrome over mono lines —
 * commands type out, logs/success fade in. No blur, no shadow.
 */
export const Terminal: React.FC<{
    label: string;
    lines: TermLine[];
    width?: number;
    height?: number;
    fontSize?: number;
    /** Frames between successive lines starting. */
    lineDelay?: number;
    /** Characters/second for typed commands. */
    cps?: number;
}> = ({ label, lines, width = 900, height = 460, fontSize = 22, lineDelay = 18, cps = 34 }) => (
    <Window label={label} width={width} height={height} meta="ZSH">
        <div
            style={{
                color: BRAND.inkMuted,
                display: "flex",
                flexDirection: "column",
                fontFamily: FONT_MONO,
                fontSize,
                gap: 10,
                lineHeight: 1.5,
                padding: "28px 30px",
            }}
        >
            {lines.map((line, i) => (
                <Sequence key={i} from={i * lineDelay} layout="none">
                    <Row line={line} cps={cps} />
                </Sequence>
            ))}
        </div>
    </Window>
);
