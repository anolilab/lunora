import { Easing, interpolate, Sequence, useCurrentFrame } from "remotion";

import { FONT_MONO } from "./fonts";
import { Window } from "./window";
import { SYNTAX } from "./theme";

const KEYWORDS = new Set([
    "import",
    "from",
    "export",
    "default",
    "const",
    "let",
    "var",
    "function",
    "return",
    "await",
    "async",
    "new",
    "if",
    "else",
    "true",
    "false",
    "null",
    "undefined",
]);

type Tok = { text: string; color: string };

/** Minimal tokenizer — just enough color anchors, never a rainbow. */
const tokenize = (line: string): Tok[] => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//")) {
        return [{ text: line, color: SYNTAX.comment }];
    }
    const out: Tok[] = [];
    const re = /("[^"]*"|'[^']*'|`[^`]*`|\b\d+\b|\b[A-Za-z_$][\w$]*\b|[^\w"'`]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
        const t = m[0];
        const c = t[0];
        if (c === '"' || c === "'" || c === "`") {
            out.push({ text: t, color: SYNTAX.string });
        } else if (/^\d+$/.test(t)) {
            out.push({ text: t, color: SYNTAX.number });
        } else if (/^[A-Za-z_$][\w$]*$/.test(t)) {
            out.push({ text: t, color: KEYWORDS.has(t) ? SYNTAX.keyword : SYNTAX.plain });
        } else {
            out.push({ text: t, color: SYNTAX.punct });
        }
    }
    return out;
};

const CodeLine: React.FC<{ tokens: Tok[]; index: number }> = ({ tokens, index }) => {
    const frame = useCurrentFrame();
    const opacity = interpolate(frame, [0, 9], [0, 1], {
        easing: Easing.out(Easing.cubic),
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });
    const shift = interpolate(frame, [0, 9], [4, 0], {
        easing: Easing.out(Easing.cubic),
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
    });

    return (
        <div style={{ display: "flex", opacity, transform: `translateY(${shift}px)`, whiteSpace: "pre" }}>
            <span
                style={{
                    color: SYNTAX.comment,
                    textAlign: "right",
                    userSelect: "none",
                    width: 34,
                }}
            >
                {String(index + 1).padStart(2, " ")}
            </span>
            <span style={{ paddingLeft: 20 }}>
                {tokens.length === 0 ? (
                    <span>&nbsp;</span>
                ) : (
                    tokens.map((t, i) => (
                        <span key={i} style={{ color: t.color }}>
                            {t.text}
                        </span>
                    ))
                )}
            </span>
        </div>
    );
};

/**
 * A Lunora code window: the sharp/hairline {@link Window} chrome over mono code
 * that reveals line-by-line (ease-out, no spring). Syntax uses the restrained
 * {@link SYNTAX} palette — moonlight default, a few aurora anchors.
 */
export const CodeBlock: React.FC<{
    filename: string;
    code: string;
    width?: number;
    height?: number;
    fontSize?: number;
    staggerFrames?: number;
}> = ({ filename, code, width = 1180, height = 560, fontSize = 26, staggerFrames = 4 }) => {
    const lines = code.split("\n");

    return (
        <Window label={filename} width={width} height={height} meta="TS">
            <div
                style={{
                    color: SYNTAX.plain,
                    display: "flex",
                    flexDirection: "column",
                    fontFamily: FONT_MONO,
                    fontSize,
                    gap: 6,
                    lineHeight: 1.55,
                    padding: "30px 36px",
                }}
            >
                {lines.map((line, i) => (
                    <Sequence key={i} from={i * staggerFrames} layout="none">
                        <CodeLine tokens={tokenize(line)} index={i} />
                    </Sequence>
                ))}
            </div>
        </Window>
    );
};
