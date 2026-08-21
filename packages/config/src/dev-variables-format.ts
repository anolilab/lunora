/**
 * The `.dev.vars` grammar — one owner, shared by every reader/writer of the
 * file so the format can't drift between packages. `@lunora/cli`'s `env`
 * command (parse/serialize) and `@lunora/config`'s scaffolder (comment-
 * preserving rewrite) do different *transforms*, but they agree on these
 * primitives: the filename, how the file parses, and what a writable `KEY`
 * looks like.
 *
 * Reading and writing are deliberately asymmetric. Reads go through dotenv —
 * literally the parser `wrangler dev` runs — so Lunora accepts every line the
 * worker accepts. Writes emit the strict `KEY="value"` subset and validate the
 * key against {@link DEV_VARS_KEY_PATTERN}, so what we generate stays boring
 * and unambiguous under that same parser.
 */
// eslint-disable-next-line e18e/ban-dependencies -- the native replacements are not equivalent here: `process.loadEnvFile` mutates `process.env` from a path (we parse content), and `node:util`'s `parseEnv` drops the `KEY: value` form dotenv accepts, so it would reintroduce the very disagreement with wrangler this module exists to remove.
import { parse } from "dotenv";

/** The conventional filename for local Cloudflare dev secrets (gitignored). */
const DEV_VARS_FILE: string = ".dev.vars";

/** Its committed, secret-free counterpart that scaffolding reads from. */
const DEV_VARS_EXAMPLE_FILE: string = ".dev.vars.example";

/**
 * A bare `KEY` identifier accepted on the **write** path — `lunora env set`,
 * `env unset`, `env generate`, and {@link upsertDevVariableLine}'s line
 * targeting. Deliberately stricter than what the reader accepts: dotenv keys
 * are `[\w.-]+`, but a key we *write* stays a conventional env-var name so it
 * needs no quoting and round-trips through every consumer. Never use this to
 * decide whether a line in an existing file counts — that is the reader's job.
 */
const DEV_VARS_KEY_PATTERN: RegExp = /^[A-Za-z_]\w*$/u;

/** Splits file content into lines on either newline style. */
const DEV_VARS_NEWLINE: RegExp = /\r?\n/u;

/**
 * Parse `.dev.vars` content into its `{ key, value }` entries, in file order.
 *
 * Delegates to dotenv's own `parse()` — the literal function `wrangler dev` /
 * `@cloudflare/vite-plugin` run over this file before handing the variables to
 * the worker. Using the library rather than a compatible reimplementation is
 * the point: every line the worker sees, Lunora reads identically, including
 * `export `-prefixed lines, dotted/dashed keys, `KEY: value` separators,
 * quote stripping (single/double/backtick), `\n`/`\r` expansion inside double
 * quotes, `#` comments ending unquoted values, and multi-line quoted values.
 * Duplicate keys resolve last-wins, at the key's first position — dotenv
 * returns an object, so a repeated key overwrites in place.
 *
 * The canonical read of the whole file: every reader of `.dev.vars` (and of
 * `.dev.vars.example`) goes through here or through {@link
 * parseDevVariableLine} below, so the format cannot drift between packages.
 */
const parseDevVariableEntries = (content: string): { key: string; value: string }[] =>
    Object.entries(parse(content)).map(([key, value]) => {
        return { key, value };
    });

/**
 * The single `{ key, value }` a one-line `.dev.vars` fragment defines, or
 * `undefined` for a blank line, a comment, or anything that isn't an entry.
 *
 * Same grammar as {@link parseDevVariableEntries} by construction (it IS that
 * parse, over one line) — the line-oriented rewriters need to know which key a
 * given line defines so they can replace that line and leave every comment and
 * blank around it verbatim, which a whole-file parse cannot tell them. A value
 * quoted across several lines is the one shape this cannot see; such a line
 * reads as its own unterminated fragment, exactly as it did before.
 */
const parseDevVariableLine = (line: string): undefined | { key: string; value: string } => parseDevVariableEntries(line)[0];

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
    parseDevVariableLine,
    upsertDevVariableLine,
};
