/**
 * The single owner of the `jsonc-parser` edit idiom the `wrangler.jsonc`
 * reconcilers share. `FORMATTING` pins the 4-space / insert-spaces formatting
 * every structural edit applies; `applyModify` runs one `modify` + `applyEdits`
 * and returns the rewritten text (or the original when the edit was a no-op),
 * preserving user comments and formatting.
 *
 * Extracted so the reconcilers (bindings, remote-bindings, compatibility-date)
 * share one copy instead of each carrying a verbatim duplicate that can drift.
 */
import { applyEdits, modify } from "jsonc-parser";

/** Formatting options every reconciler applies so edits match the repo's 4-space style. */
const FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 4 } } as const;

/** Apply one structural jsonc edit and return the rewritten text (a no-op edit returns the input). */
const applyModify = (text: string, path: ReadonlyArray<number | string>, value: unknown): string => {
    const edits = modify(text, [...path], value, FORMATTING);

    return edits.length > 0 ? applyEdits(text, edits) : text;
};

export { applyModify, FORMATTING };
