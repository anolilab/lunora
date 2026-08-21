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

/** Line-break split that KEEPS each terminator as its own part, so a rewrite can put it back verbatim. */
const CAPTURED_LINE_BREAK = /(\r?\n)/u;

/**
 * Rewrite every `.dev.vars` line that *defines* `key`, leaving all other lines
 * — comments, blanks, other entries — byte-for-byte alone, including their own
 * line terminators (a CRLF file stays CRLF; a missing final newline stays
 * missing). `rendered === undefined` deletes the matching lines; otherwise the
 * FIRST match is replaced in place (keeping its position in the file) and
 * every later duplicate is dropped. Returns the new content plus whether any
 * line matched, which is what tells `upsert` to append instead.
 *
 * Which lines count is decided by {@link parseDevVariableLine} — the reader's
 * own grammar — and never by a pattern of this function's own. That is
 * load-bearing: the writers used to target lines with a hand-rolled
 * `^[ \t]*KEY[ \t]*=` regex, so when the reader moved to dotenv the two
 * disagreed about lines like `export AUTH_SECRET=…`. `env unset` then found
 * the key (reader), rewrote nothing (writer), and reported success — telling a
 * developer a leaked credential was revoked while `wrangler dev` still loaded
 * it. Anything the reader can see, the writers can now edit.
 *
 * Known ceiling: a value quoted across several lines is edited by its first
 * line only, leaving the continuation lines behind. Writers never emit that
 * shape (`env set` rejects newline values) so it can only arrive hand-written,
 * and this is the behaviour that shipped before. Handle it here if a real file
 * ever needs it.
 */
const rewriteDevVariableLines = (content: string, key: string, rendered: string | undefined): { content: string; matched: boolean } => {
    // Capturing split keeps every terminator as its own part, so lines pair up
    // as [text, terminator, text, terminator, …, trailingText].
    const parts = content.split(CAPTURED_LINE_BREAK);
    const out: string[] = [];
    let matched = false;

    for (let index = 0; index < parts.length; index += 2) {
        const line = parts[index] ?? "";
        const terminator = parts[index + 1] ?? "";

        if (parseDevVariableLine(line)?.key !== key) {
            out.push(line, terminator);

            continue;
        }

        const isFirstMatch = !matched;

        matched = true;

        if (rendered !== undefined && isFirstMatch) {
            out.push(rendered, terminator);
        }
    }

    return { content: out.join(""), matched };
};

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
 * Duplicate lines for the key are collapsed down to exactly one. The shared
 * read path is last-wins — dotenv overwrites the key as it walks the file — so
 * replacing only the first match would leave a later, untouched duplicate
 * still winning at read time, i.e. a `set` that silently didn't take effect.
 */
const upsertDevVariableLine = (content: string, key: string, value: string): string => {
    const rendered = `${key}="${value}"`;
    const replaced = rewriteDevVariableLines(content, key, rendered);

    if (replaced.matched) {
        return replaced.content;
    }

    if (content === "") {
        return `${rendered}\n`;
    }

    return content.endsWith("\n") ? `${content}${rendered}\n` : `${content}\n${rendered}\n`;
};

/**
 * Surgically remove every `.dev.vars` line defining `key` (and its own line
 * terminator), preserving all other lines, comments, and blanks verbatim.
 * Backs `lunora env unset`.
 */
const removeDevVariableLine = (content: string, key: string): string => rewriteDevVariableLines(content, key, undefined).content;

export {
    DEV_VARS_EXAMPLE_FILE,
    DEV_VARS_FILE,
    DEV_VARS_KEY_PATTERN,
    DEV_VARS_NEWLINE,
    escapeRegExp,
    parseDevVariableEntries,
    parseDevVariableLine,
    removeDevVariableLine,
    upsertDevVariableLine,
};
