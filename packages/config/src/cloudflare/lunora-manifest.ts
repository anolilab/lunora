/**
 * The project's `package.json` `lunora` object, where the wrangler reconcilers
 * record which config they wrote: `lunora.crons` (see `reconcile-crons.ts`, which
 * also explains why the record lives here and not in the wrangler config) and
 * `lunora.queueTuning` (see `reconcile-bindings.ts`).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { FormattingOptions } from "jsonc-parser";
import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser";

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

/** `value` as JSON with every object's keys sorted, so two orderings of one record compare equal. Array order is kept: it is data. */
const canonical = (value: unknown): string | undefined =>
    JSON.stringify(value, (_key, item: unknown) =>
        typeof item === "object" && item !== null && !Array.isArray(item)
            ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => a.localeCompare(b)))
            : item,
    );

/**
 * Set the property at `path` (one or two keys deep) to `value`, touching only
 * that property's own text.
 *
 * Not `modify(..., { formattingOptions })`: its formatter works on whole lines,
 * and an insertion starts on the line of the property before it, so a sibling
 * a formatter keeps inline (`"scripts": { "dev": "…" }`) was expanded as a side
 * effect of recording ownership.
 */
const writeKey = (text: string, path: ReadonlyArray<string>, value: unknown): string => {
    const formatting = formattingFor(text);
    const unit = formatting.insertSpaces === false ? "\t" : " ".repeat(formatting.tabSize ?? 4);
    const eol = formatting.eol ?? "\n";
    const pad = unit.repeat(path.length);
    const pretty = JSON.stringify(value, undefined, unit)
        .split("\n")
        .join(eol + pad);
    const tree = parseTree(text);
    const existing = tree === undefined ? undefined : findNodeAtLocation(tree, [...path]);

    if (existing !== undefined) {
        return text.slice(0, existing.offset) + pretty + text.slice(existing.offset + existing.length);
    }

    let parent = tree;

    if (tree !== undefined && path.length > 1) {
        parent = findNodeAtLocation(tree, path.slice(0, -1));
    }
    const key = JSON.stringify(path.at(-1));

    if (parent === undefined && path.length > 1) {
        // `lunora` itself is absent: write it, holding the key.
        return writeKey(text, path.slice(0, -1), { [path.at(-1) as string]: value });
    }

    if (parent?.type !== "object") {
        // No manifest object to anchor to: let jsonc-parser build it.
        return applyEdits(text, modify(text, [...path], value, { formattingOptions: formatting }));
    }

    const last = parent.children?.at(-1);

    if (last === undefined) {
        const inner = `${eol}${pad}${key}: ${pretty}${eol}${unit.repeat(path.length - 1)}`;

        return `${text.slice(0, parent.offset + 1)}${inner}${text.slice(parent.offset + parent.length - 1)}`;
    }

    const end = last.offset + last.length;

    return `${text.slice(0, end)},${eol}${pad}${key}: ${pretty}${text.slice(end)}`;
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

    // Compared as data, not as text: a record a formatter keeps inline, or in
    // another key order, is the same record, and rewriting it into
    // jsonc-parser's layout would dirty package.json on every pass.
    if (canonical(manifest.lunora?.[key]) === canonical(value)) {
        return;
    }

    const path = value === undefined && onlyOwnKey ? ["lunora"] : ["lunora", key];
    const next = value === undefined ? applyEdits(manifest.text, modify(manifest.text, path, undefined, {})) : writeKey(manifest.text, path, value);

    if (next !== manifest.text) {
        writeFileSync(manifest.path, next, "utf8");
    }
};

export type { Manifest };
export { formattingFor, readManifest, recordManifestKey };
