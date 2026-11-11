import type { ReactElement } from "react";

import type { TokenKind } from "./json-tokenize";
import { tokenize } from "./json-tokenize";

/** Token colour per kind, mapped to the Lunora aurora + data-status palette (keys cyan, strings green, numbers amber, literals violet). */
const KIND_CLASS: Record<TokenKind, string> = {
    boolean: "text-royal-amethyst",
    key: "text-sky-sapphire",
    number: "text-warning",
    plain: "",
    string: "text-success",
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
