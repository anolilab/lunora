import type { ReactElement } from "react";
/** A classified slice of a JSON string. `plain` covers braces, commas and whitespace (rendered uncoloured). */
type TokenKind = "boolean" | "key" | "number" | "plain" | "string";

interface Token {
    readonly kind: TokenKind;
    /** Character offset in the source — a stable, unique React key (token text repeats, positions don't). */
    readonly start: number;
    readonly text: string;
}

/** Token colour per kind, mapped to the Lunora aurora + data-status palette (keys cyan, strings green, numbers amber, literals violet). */
const KIND_CLASS: Record<TokenKind, string> = {
    boolean: "text-royal-amethyst",
    key: "text-sky-sapphire",
    number: "text-warning",
    plain: "",
    string: "text-success",
};

// One pass over the source: a quoted string, a literal keyword, or a number. Keys are told apart from string values afterwards (by a trailing colon).
const TOKEN = /"(?:[^"\\]|\\.)*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?/g;

/** A colon (after optional whitespace) at the start of the remaining source — marks a preceding string as an object key. */
const COLON_AHEAD = /^\s*:/;

/** Classify a single matched run; a quoted string is a key when the next non-space character is a colon, else a value. */
const classify = (code: string, end: number, text: string): TokenKind => {
    if (text.startsWith('"')) {
        return COLON_AHEAD.test(code.slice(end)) ? "key" : "string";
    }

    if (text === "true" || text === "false" || text === "null") {
        return "boolean";
    }

    return "number";
};

/** Split a (pretty-printed) JSON string into classified tokens; non-JSON input degrades to a single `plain` run. */
const tokenize = (code: string): Token[] => {
    const tokens: Token[] = [];
    let lastIndex = 0;

    for (const match of code.matchAll(TOKEN)) {
        const { index } = match;
        const text = match[0];
        const end = index + text.length;

        if (index > lastIndex) {
            tokens.push({ kind: "plain", start: lastIndex, text: code.slice(lastIndex, index) });
        }

        tokens.push({ kind: classify(code, end, text), start: index, text });
        lastIndex = end;
    }

    if (lastIndex < code.length) {
        tokens.push({ kind: "plain", start: lastIndex, text: code.slice(lastIndex) });
    }

    return tokens;
};

interface JsonHighlightProps {
    readonly code: string;
}

/**
 * Inline JSON syntax highlighting — a dependency-free tokenizer that colours
 * keys, string/number/boolean values, and leaves structural punctuation muted.
 * Returns a fragment of coloured spans meant to live inside the caller's own
 * pre element (so the surrounding layout, scroll, and test ids stay put). Used
 * for the right-rail response bodies (examples and live results), which are
 * always well-formed JSON; any non-JSON input simply renders uncoloured.
 */
const JsonHighlight = ({ code }: JsonHighlightProps): ReactElement => {
    const tokens = tokenize(code);

    return (
        <>
            {tokens.map((token) => (
                <span className={KIND_CLASS[token.kind]} key={token.start}>
                    {token.text}
                </span>
            ))}
        </>
    );
};

export default JsonHighlight;
export { tokenize };
