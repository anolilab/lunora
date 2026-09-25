/**
 * The project's `package.json` `lunora` object, where the wrangler reconcilers
 * record which config they wrote: `lunora.crons` (see `reconcile-crons.ts`, which
 * also explains why the record lives here and not in the wrangler config) and
 * `lunora.queueTuning` (see `reconcile-bindings.ts`).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { FormattingOptions } from "jsonc-parser";
import { applyEdits, modify } from "jsonc-parser";

import join from "../path";

/** Leading whitespace of the first indented line — the file's own indent unit. */
const INDENT = /^([\t ]+)"/mu;

/**
 * The file's indentation and line ending, so an inserted key does not fight the
 * rest of it: a `\n` written into an otherwise-CRLF config shows as a diff on
 * every Windows checkout, and npm's two-space manifests should not be
 * re-indented to four.
 */
const formattingFor = (text: string): FormattingOptions => {
    const indent = INDENT.exec(text)?.[1] ?? "    ";

    return { eol: text.includes("\r\n") ? "\r\n" : "\n", insertSpaces: !indent.startsWith("\t"), tabSize: indent.length };
};

interface Manifest {
    /** The manifest's `lunora` value, when it has one and it is an object. */
    lunora: Record<string, unknown> | undefined;

    /**
     * `true` when the manifest holds a `lunora` value that is NOT a plain object.
     * {@link readManifest} normalises that to `lunora: undefined`, but the TEXT
     * still has it — and `modify(text, ["lunora", "crons"], …)` throws
     * `Can not add index to parent of type string` on a scalar or array parent.
     */
    lunoraIsForeign: boolean;
    path: string;
    text: string;
}

/**
 * The project manifest, or `undefined` when it is missing or is not readable
 * JSON.
 *
 * Unreadable reads as "no ownership recorded" rather than throwing: this runs
 * inside a deploy and inside every dev-server schema save, where a manifest that
 * broken already fails for reasons that have nothing to do with the record.
 */
const readManifest = (projectRoot: string): Manifest | undefined => {
    const path = join(projectRoot, "package.json");

    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const text = readFileSync(path, "utf8");
        const { lunora }: { lunora?: unknown } = JSON.parse(text) as { lunora?: unknown };
        const isObject = typeof lunora === "object" && lunora !== null && !Array.isArray(lunora);

        return { lunora: isObject ? (lunora as Record<string, unknown>) : undefined, lunoraIsForeign: lunora !== undefined && !isObject, path, text };
    } catch {
        return undefined;
    }
};

/**
 * Set `lunora.<key>` to `value`, or drop it when `value` is `undefined` — and
 * the `lunora` object with it, when nothing else lives there, so a project with
 * nothing recorded keeps an unmarked manifest.
 */
const recordManifestKey = (manifest: Manifest, key: string, value: unknown): void => {
    // Drop the whole `lunora` object only when `key` is the ONLY thing in it.
    // Counting keys is not the same test: an app whose manifest holds one key that
    // is NOT `key` — a `registryUrl`, say — matched `length <= 1` and had its own
    // configuration deleted by the code whose entire purpose is not to delete
    // user-owned config.
    const onlyOwnKey = Object.keys(manifest.lunora ?? {}).every((existing) => existing === key);
    // A `lunora` that is a string or an array cannot be indexed into — writing
    // `["lunora", key]` against it throws out of `jsonc-parser`. Leave it
    // completely alone rather than replacing it: whatever it means, it is the
    // app's. The cost is that ownership goes unrecorded, so the caller degrades
    // to never removing what it wrote — loud in the config, versus silent data loss.
    if (manifest.lunoraIsForeign) {
        return;
    }

    const path = value === undefined && onlyOwnKey ? ["lunora"] : ["lunora", key];
    const edits = modify(manifest.text, path, value, { formattingOptions: formattingFor(manifest.text) });

    if (edits.length === 0) {
        return;
    }

    const next = applyEdits(manifest.text, edits);

    if (next !== manifest.text) {
        writeFileSync(manifest.path, next, "utf8");
    }
};

export type { Manifest };
export { formattingFor, readManifest, recordManifestKey };
