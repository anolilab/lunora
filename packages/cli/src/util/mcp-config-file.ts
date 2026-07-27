/**
 * Read-modify-write for an MCP client's JSON config.
 *
 * These files belong to the user, not to us: they hold the other servers they
 * have wired up, and (for the several clients that accept JSONC) their comments
 * and formatting. So edits go through `jsonc-parser`'s `modify`, which splices
 * a single value into the existing text, rather than a `JSON.parse` →
 * `JSON.stringify` round trip that would silently reformat the file and drop
 * every comment in it.
 *
 * A file we cannot parse is left strictly alone — reporting `"invalid"` beats
 * overwriting a config whose syntax error is probably a work in progress.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

import { dirname } from "@visulima/path";
import type { ParseError } from "jsonc-parser";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";

/**
 * Write `contents` to `path` atomically: a sibling temp file, then a rename.
 *
 * These paths include files this CLI does not own and did not create —
 * `~/.claude.json`, `~/Library/Application Support/Claude/…`,
 * `~/.codeium/windsurf/mcp_config.json` — holding every other MCP server the
 * user has configured. `writeFileSync` truncates before it writes, so a crash,
 * a Ctrl-C, or a full disk in between leaves that file empty, with no backup.
 * `rename` within a directory is atomic, so a reader sees the old file or the
 * new one and never a half-written one.
 *
 * Two things the naive temp-then-rename gets wrong, both silent:
 *
 * - **Mode.** A fresh temp file is `0666 & ~umask`, normally `0644`. Renaming it
 * over a `0600` config — which is what Zed's `settings.json` and Claude
 * Desktop's are, because they hold `env` blocks full of API tokens — makes
 * those secrets world-readable. Carry the original mode across.
 * - **Symlinks.** `rename` replaces the *link*, not its target, so a config
 * managed by stow/chezmoi silently becomes a regular file and the dotfiles repo
 * keeps a stale copy that still reads as clean. Resolve first.
 */
const writeAtomic = (path: string, contents: string): void => {
    // Resolve through any symlink so both the mode we copy and the file we
    // replace are the real one.
    let target = path;
    let mode: number | undefined;

    try {
        target = realpathSync(path);
        mode = statSync(target).mode;
    } catch {
        // New file (or an unreadable one): nothing to preserve, create fresh.
    }

    // A random suffix, so two concurrent runs cannot clobber each other's temp
    // file and a crash cannot leave one that the next run silently reuses.
    // eslint-disable-next-line sonarjs/pseudo-random -- a temp-file suffix, not a security token: it only needs to differ between concurrent runs
    const temporaryPath = `${target}.lunora-${Math.random().toString(36).slice(2, 10)}.tmp`;

    try {
        writeFileSync(temporaryPath, contents, "utf8");

        if (mode !== undefined) {
            chmodSync(temporaryPath, mode);
        }

        renameSync(temporaryPath, target);
    } catch (error: unknown) {
        try {
            unlinkSync(temporaryPath);
        } catch {
            // Nothing to clean up, or we can't — the original is intact either way.
        }

        throw error;
    }
};

/** Formatting applied to spliced-in values, matching the repo's 4-space style. */
const FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 4 } } as const;

/** What {@link upsertMcpEntry} did. */
type UpsertAction =
    /** The file did not exist and was created. */
    | "created"
    /** The file exists but could not be parsed; nothing was written. */
    | "invalid"
    /** An entry with this name was already present and `force` was not set. */
    | "skipped"
    /** The entry was added to (or replaced in) an existing file. */
    | "updated";

interface UpsertMcpEntryOptions {
    /** The server entry to store. */
    entry: Record<string, unknown>;
    /** Replace an entry that already exists under `name`. */
    force?: boolean;
    /** Top-level key holding the server map (`mcpServers`, `servers`, …). */
    key: string;
    /** Server name, i.e. the key inside the server map. */
    name: string;
    /** Absolute path of the config file. */
    path: string;
}

interface UpsertMcpEntryResult {
    action: UpsertAction;
    /** Set when `action` is `"invalid"`: the first parse error, for the message. */
    error?: string;
    path: string;
}

/** Parse JSONC tolerantly; `undefined` means the text is not recoverable JSON. */
const parseConfig = (text: string): { errors: ParseError[]; value: unknown } => {
    const errors: ParseError[] = [];
    const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });

    return { errors, value };
};

/** True for a JSON object (`{}`), excluding `null` and arrays — both are `typeof "object"`. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The entry currently stored at `[key][name]`, if any. */
const existingEntry = (value: unknown, key: string, name: string): unknown => {
    if (!isPlainObject(value)) {
        return undefined;
    }

    const map = value[key];

    return isPlainObject(map) ? map[name] : undefined;
};

/**
 * What a write to `path` would find there: the entry already present, nothing,
 * or a file we would refuse to touch.
 *
 * Read-only counterpart to {@link upsertMcpEntry} and {@link removeMcpEntry}, so
 * a dry run predicts what a real run would do. `"invalid"` is reported rather
 * than folded into `"absent"`: a rehearsal that hides the one condition the user
 * must fix first is worse than no rehearsal.
 */
const inspectMcpEntry = (options: { key: string; name: string; path: string }): "absent" | "invalid" | "present" => {
    if (!existsSync(options.path)) {
        return "absent";
    }

    let text: string;

    try {
        text = readFileSync(options.path, "utf8");
    } catch {
        return "invalid";
    }

    if (text.trim().length === 0) {
        return "absent";
    }

    const { errors, value } = parseConfig(text);

    if (errors.length > 0 || !isPlainObject(value)) {
        return "invalid";
    }

    return existingEntry(value, options.key, options.name) === undefined ? "absent" : "present";
};

/** True when `path` already holds an entry at `[key][name]`. */
const hasMcpEntry = (options: { key: string; name: string; path: string }): boolean => inspectMcpEntry(options) === "present";

/**
 * Add (or replace) one server entry in an MCP client config, creating the file
 * and its parent directory when absent.
 */
const upsertMcpEntry = (options: UpsertMcpEntryOptions): UpsertMcpEntryResult => {
    const { entry, force = false, key, name, path } = options;

    if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        writeAtomic(path, `${JSON.stringify({ [key]: { [name]: entry } }, undefined, 4)}\n`);

        return { action: "created", path };
    }

    const text = readFileSync(path, "utf8");

    // An empty (or whitespace-only) file parses to `undefined` with no errors;
    // treat it as a fresh file rather than as unrecoverable.
    if (text.trim().length === 0) {
        writeAtomic(path, `${JSON.stringify({ [key]: { [name]: entry } }, undefined, 4)}\n`);

        return { action: "created", path };
    }

    const { errors, value } = parseConfig(text);

    if (errors.length > 0) {
        return { action: "invalid", error: `parse error at offset ${String(errors[0]?.offset ?? 0)}`, path };
    }

    if (!isPlainObject(value)) {
        return { action: "invalid", error: "the file's root is not a JSON object", path };
    }

    // `modify` throws when the path it must descend isn't an object — an array,
    // a string, or `null` at `[key]` are all plausible in a hand-edited config,
    // and an escaping throw would abort the whole install mid-way, leaving
    // earlier clients written and later ones silently skipped.
    const existingMap = value[key];

    if (existingMap !== undefined && !isPlainObject(existingMap)) {
        return { action: "invalid", error: `"${key}" is not an object`, path };
    }

    if (existingEntry(value, key, name) !== undefined && !force) {
        return { action: "skipped", path };
    }

    try {
        const edits = modify(text, [key, name], entry, FORMATTING);

        if (edits.length > 0) {
            writeAtomic(path, applyEdits(text, edits));
        }
    } catch (error: unknown) {
        // Last line of defence: report the file rather than unwinding the
        // caller's loop over the remaining clients.
        return { action: "invalid", error: error instanceof Error ? error.message : String(error), path };
    }

    return { action: "updated", path };
};

/** What {@link removeMcpEntry} did. */
type RemoveAction =
    /** The entry was deleted. */
    | "removed"
    /** No such file, or no such entry in it — nothing to do. */
    | "absent"
    /** The file exists but could not be parsed; nothing was written. */
    | "invalid";

interface RemoveMcpEntryResult {
    action: RemoveAction;
    error?: string;
    path: string;
}

/**
 * Delete one server entry from an MCP client config, leaving every other entry
 * — and the file's comments and formatting — untouched.
 *
 * The counterpart to {@link upsertMcpEntry}, and the reason `install` is safe to
 * try: a command that writes into files across a user's machine owes them a way
 * to take it back out. `modify` with an `undefined` value is jsonc-parser's
 * delete, so this reuses the same comment-preserving splice as the write path.
 */
const removeMcpEntry = (options: { key: string; name: string; path: string }): RemoveMcpEntryResult => {
    const { key, name, path } = options;

    if (!existsSync(path)) {
        return { action: "absent", path };
    }

    let text: string;

    try {
        text = readFileSync(path, "utf8");
    } catch (error: unknown) {
        // `uninstall` walks every client's every scope, so one unreadable path
        // (a directory, a permission error) must be reported, not thrown out of
        // the caller's loop leaving earlier clients half-done.
        return { action: "invalid", error: error instanceof Error ? error.message : String(error), path };
    }

    const { errors, value } = parseConfig(text);

    if (errors.length > 0) {
        return { action: "invalid", error: `parse error at offset ${String(errors[0]?.offset ?? 0)}`, path };
    }

    if (existingEntry(value, key, name) === undefined) {
        return { action: "absent", path };
    }

    try {
        const edits = modify(text, [key, name], undefined, FORMATTING);

        if (edits.length > 0) {
            writeAtomic(path, applyEdits(text, edits));
        }
    } catch (error: unknown) {
        return { action: "invalid", error: error instanceof Error ? error.message : String(error), path };
    }

    return { action: "removed", path };
};

export type { RemoveAction, RemoveMcpEntryResult, UpsertAction, UpsertMcpEntryOptions, UpsertMcpEntryResult };
export { hasMcpEntry, inspectMcpEntry, removeMcpEntry, upsertMcpEntry };
