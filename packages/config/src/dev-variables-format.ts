/**
 * The `.dev.vars` line grammar — one owner, shared by every reader/writer of the
 * file so the format can't drift between packages. `@lunora/cli`'s `env`
 * command (parse/serialize) and `@lunora/config`'s scaffolder (comment-
 * preserving rewrite) do different *transforms*, but they agree on these
 * primitives: the filename, what a `KEY` looks like, how lines split, and how
 * quotes strip.
 */

/** The conventional filename for local Cloudflare dev secrets (gitignored). */
const DEV_VARS_FILE: string = ".dev.vars";

/** Its committed, secret-free counterpart that scaffolding reads from. */
const DEV_VARS_EXAMPLE_FILE: string = ".dev.vars.example";

/** A bare `KEY` identifier — the part left of `=` in a `.dev.vars` line. */
const DEV_VARS_KEY_PATTERN: RegExp = /^[A-Za-z_]\w*$/u;

/** Splits file content into lines on either newline style. */
const DEV_VARS_NEWLINE: RegExp = /\r?\n/u;

/** Strip one layer of matching single/double quotes from a value, if present. */
const unquoteDevVariable = (value: string): string => {
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        return value.slice(1, -1);
    }

    return value;
};

/**
 * Split one `.dev.vars` line into its `key` and (trimmed, still-quoted) `value`
 * at the first `=`. Returns `undefined` for blank lines, comments, and anything
 * whose left side isn't a valid `KEY` (so a comment containing `=` is ignored).
 */
const splitDevVariableLine = (line: string): undefined | { key: string; value: string } => {
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
        return undefined;
    }

    const equals = trimmed.indexOf("=");

    if (equals <= 0) {
        return undefined;
    }

    const key = trimmed.slice(0, equals).trim();

    if (!DEV_VARS_KEY_PATTERN.test(key)) {
        return undefined;
    }

    return { key, value: trimmed.slice(equals + 1).trim() };
};

/**
 * Parse `.dev.vars` content into its `{ key, value }` entries, in file order,
 * with values unquoted and comments/blank/invalid lines dropped. The canonical
 * read of the whole file — callers that just want the variables (rather than a
 * comment-preserving rewrite) use this instead of hand-rolling the split loop.
 */
const parseDevVariableEntries = (content: string): { key: string; value: string }[] => {
    const entries: { key: string; value: string }[] = [];

    for (const line of content.split(DEV_VARS_NEWLINE)) {
        const parsed = splitDevVariableLine(line);

        if (parsed) {
            entries.push({ key: parsed.key, value: unquoteDevVariable(parsed.value) });
        }
    }

    return entries;
};

export { DEV_VARS_EXAMPLE_FILE, DEV_VARS_FILE, DEV_VARS_KEY_PATTERN, DEV_VARS_NEWLINE, parseDevVariableEntries, splitDevVariableLine, unquoteDevVariable };
