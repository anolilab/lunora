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

/**
 * Escape a runtime string for safe literal interpolation into a `RegExp`
 * source. The one canonical implementation — `@lunora/config`'s own
 * `infer-bindings.ts` (type-only-export detection) and `@lunora/cli`'s `env`
 * command both need this and used to carry their own (functionally
 * identical) copy; grammar this fundamental gets one owner like everything
 * else in this module.
 */
const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/**
 * Match the `.dev.vars` line that *defines* `key` (matching `splitDevVariableLine`
 * above: optional leading whitespace, the key, optional whitespace, then `=`).
 * Comment (`#…`) and blank lines never match. Keys are always validated against
 * `DEV_VARS_KEY_PATTERN` before we build this, so they hold only `[A-Za-z_]\w*`
 * — no regex metacharacters to escape in practice — but `key` is escaped anyway
 * as defense-in-depth against a future caller that skips validation.
 *
 * The trailing `(\r?\n|$)` capture consumes the line's own line terminator (or
 * matches the zero-width end-of-string when the line is the file's last, with
 * no trailing newline) — `upsertDevVariableLine` needs this to drop a whole
 * duplicate line, not just its content, leaving no blank line behind.
 *
 * `global` selects the all-matches form (`g`) `upsertDevVariableLine` needs to
 * collapse every duplicate `KEY=` line down to one, vs. a plain single-match
 * form for the `.test()` existence check. Callers must not reuse ONE instance
 * for both a `.test()` and a `.replace()` — a global regex's `.test()` mutates
 * `lastIndex`, which would make a subsequent `.replace()` on the same instance
 * silently start scanning mid-file. Module-private: the one caller
 * (`upsertDevVariableLine`) needs both the capturing group and the `global`
 * toggle, which a general-purpose export would not serve any better than
 * calling this directly.
 */
const devVariableLinePattern = (key: string, global: boolean): RegExp =>
    new RegExp(String.raw`^[ \t]*${escapeRegExp(key)}[ \t]*=.*(\r?\n|$)`, global ? "gmu" : "mu");

/**
 * Surgically upsert a single `KEY="value"` line in raw `.dev.vars` content,
 * leaving every comment, blank line, and untouched entry verbatim. Rebuilding
 * the whole file from the parsed entry map (an earlier approach) silently
 * dropped all `# …` comments and blank lines — including the documentation the
 * registry installer and scaffolder write — and re-quoted lines the user never
 * touched. If the key already has a line it is replaced in place; otherwise the
 * new line is appended with a single trailing newline. Always quotes the value
 * to preserve a whitespace round-trip; callers (`env set`, `env generate --set`,
 * `deploy`'s minted-secret disclosure) reject newline/`"`/`\` up front so the
 * verbatim quote is safe.
 *
 * Duplicate `KEY=` lines are collapsed down to exactly one. The shared read
 * path (`parseDevVariableEntries` above) is last-wins — it keeps overwriting a
 * Map entry as it walks the file, so with duplicate lines the LAST one wins at
 * read time. Replacing only the first match (as a plain, non-global
 * `.replace()` does) left that later, untouched duplicate still winning at read
 * time — a `set` that silently didn't take effect. The first matching line is
 * replaced in place (preserving its position in the file); every later
 * duplicate is dropped entirely (including its own trailing newline).
 */
const upsertDevVariableLine = (content: string, key: string, value: string): string => {
    const rendered = `${key}="${value}"`;

    if (!devVariableLinePattern(key, false).test(content)) {
        if (content === "") {
            return `${rendered}\n`;
        }

        return content.endsWith("\n") ? `${content}${rendered}\n` : `${content}\n${rendered}\n`;
    }

    let replacedFirst = false;

    // Replace via a function so `$`-bearing values aren't treated as
    // replacement-string special patterns.
    return content.replace(devVariableLinePattern(key, true), (_match: string, newline: string) => {
        if (replacedFirst) {
            return "";
        }

        replacedFirst = true;

        return `${rendered}${newline}`;
    });
};

export {
    DEV_VARS_EXAMPLE_FILE,
    DEV_VARS_FILE,
    DEV_VARS_KEY_PATTERN,
    DEV_VARS_NEWLINE,
    escapeRegExp,
    parseDevVariableEntries,
    splitDevVariableLine,
    unquoteDevVariable,
    upsertDevVariableLine,
};
