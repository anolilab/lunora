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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { dirname } from "@visulima/path";
import type { ParseError } from "jsonc-parser";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";

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

/** The entry currently stored at `[key][name]`, if any. */
const existingEntry = (value: unknown, key: string, name: string): unknown => {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const map = (value as Record<string, unknown>)[key];

    return typeof map === "object" && map !== null ? (map as Record<string, unknown>)[name] : undefined;
};

/**
 * Add (or replace) one server entry in an MCP client config, creating the file
 * and its parent directory when absent.
 */
const upsertMcpEntry = (options: UpsertMcpEntryOptions): UpsertMcpEntryResult => {
    const { entry, force = false, key, name, path } = options;

    if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify({ [key]: { [name]: entry } }, undefined, 4)}\n`, "utf8");

        return { action: "created", path };
    }

    const text = readFileSync(path, "utf8");

    // An empty (or whitespace-only) file parses to `undefined` with no errors;
    // treat it as a fresh file rather than as unrecoverable.
    if (text.trim().length === 0) {
        writeFileSync(path, `${JSON.stringify({ [key]: { [name]: entry } }, undefined, 4)}\n`, "utf8");

        return { action: "created", path };
    }

    const { errors, value } = parseConfig(text);

    if (errors.length > 0 || typeof value !== "object" || value === null) {
        return { action: "invalid", error: errors.length > 0 ? `parse error at offset ${String(errors[0]?.offset ?? 0)}` : "not a JSON object", path };
    }

    if (existingEntry(value, key, name) !== undefined && !force) {
        return { action: "skipped", path };
    }

    const edits = modify(text, [key, name], entry, FORMATTING);

    if (edits.length > 0) {
        writeFileSync(path, applyEdits(text, edits), "utf8");
    }

    return { action: "updated", path };
};

export type { UpsertAction, UpsertMcpEntryOptions, UpsertMcpEntryResult };
export { upsertMcpEntry };
