import { writeFileSync } from "node:fs";

import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser";

import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";

/** Shallow structural equality for two string arrays (order-sensitive). */
const sameTriggers = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * The ownership marker: a JSONC line comment sitting immediately above
 * `triggers.crons` that records the exact set this reconciler generated last
 * time. Everything in the array that is not in it belongs to the user.
 *
 * It lives in `wrangler.jsonc` — not in gitignored `.lunora/` state — because it
 * has to survive a fresh clone: a CI-only deploy has no local state, and an
 * add-only fallback there would leave a removed cron firing forever.
 */
const MARKER_PREFIX = "// lunora:crons ";

const MARKER_SUFFIX = " — generated from lunora/crons.ts; every other entry is yours and is left alone";

/** Whole marker line (with its newline), for stripping the previous one. */
const MARKER_LINE = /^[^\S\n]*\/\/ lunora:crons \[[^\]\n]*\][^\n]*\n/gmu;

/** The marker's payload — cron expressions never contain `]`, so a lazy class is enough. */
const MARKER_VALUE = /^[^\S\n]*\/\/ lunora:crons (\[[^\]\n]*\])/mu;

/** Leading whitespace of a line. */
const LEADING_SPACE = /^[^\S\n]*/u;

export interface ReconcileResult {
    /** `true` when `wrangler.jsonc` was rewritten. */
    changed: boolean;
    /** Human-readable reason when reconciliation was skipped (for logging). */
    reason?: string;
    /** Resolved wrangler path, or `undefined` when none was found. */
    wranglerPath?: string;
}

/**
 * The cron set this reconciler wrote on its last pass, or `undefined` when the
 * file carries no marker (a project that predates it, or one nobody has
 * reconciled yet). A malformed marker reads as absent rather than throwing.
 */
const readManagedCrons = (text: string): string[] | undefined => {
    const match = MARKER_VALUE.exec(text);

    if (!match?.[1]) {
        return undefined;
    }

    try {
        const parsed: unknown = JSON.parse(match[1]);

        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Replace the marker line with one naming `managed`, or drop it when this
 * reconciler owns nothing (so a project with no crons keeps a marker-free
 * config). Positioned by the parsed offset of `triggers.crons` rather than by
 * text search, and inserted at the start of that line so an inline
 * `"triggers": { "crons": [...] }` gets the comment above the whole line
 * instead of inside it.
 */
const withMarker = (text: string, managed: ReadonlyArray<string>): string => {
    const stripped = text.replaceAll(MARKER_LINE, "");

    if (managed.length === 0) {
        return stripped;
    }

    const root = parseTree(stripped);
    const node = root === undefined ? undefined : findNodeAtLocation(root, ["triggers", "crons"]);
    const offset = node?.parent?.offset ?? node?.offset;

    if (offset === undefined) {
        return stripped;
    }

    const lineStart = stripped.lastIndexOf("\n", offset) + 1;
    const prefix = stripped.slice(lineStart, offset);
    const indent = prefix.trim() === "" ? prefix : (LEADING_SPACE.exec(stripped.slice(lineStart))?.[0] ?? "");

    return `${stripped.slice(0, lineStart)}${indent}${MARKER_PREFIX}${JSON.stringify([...managed])}${MARKER_SUFFIX}\n${stripped.slice(lineStart)}`;
};

/**
 * Reconcile the codegen-derived cron schedules into the project's
 * `wrangler.jsonc` `triggers.crons` array, preserving comments and formatting
 * via `jsonc-parser`'s structural edits.
 *
 * **This does not own the whole array.** Two runtime cron surfaces are invisible
 * to codegen and are documented as needing a hand-written `triggers.crons` entry:
 * `createWorker({ backupCron })` (the nightly NDJSON backup) and
 * `createWorker({ crons })` (handlers keyed by expression). Replacing the array
 * wholesale deleted both on the next `lunora deploy` or dev-server schema save,
 * silently — the nightly backup simply stopped. So an entry this reconciler did
 * not generate is the user's and is preserved.
 *
 * Ownership is recorded in the {@link MARKER_PREFIX} comment above the array,
 * which is why a REMOVED generated cron still gets cleared (it is in the marker
 * and not in `cronTriggers`) while a hand-written one never is. The marker is
 * rewritten on every pass, including one that changes no entry, so a config that
 * predates it becomes precise after a single codegen run; until then unknown
 * entries are treated as the user's, which is the safe direction.
 *
 * When both array and marker already match, nothing is written (so we don't
 * churn the file or trip the dev server's file watcher).
 *
 * This intentionally writes the SAME `triggers.crons` shape the
 * `@lunora/config` validator accepts, so the wrangler validator never fights
 * the generated value.
 */
export const reconcileWranglerCrons = (projectRoot: string, cronTriggers: ReadonlyArray<string>): ReconcileResult => {
    const wranglerPath = findWranglerFile(projectRoot);

    if (!wranglerPath) {
        return { changed: false, reason: "wrangler.jsonc not found" };
    }

    const { parsed, text } = readWranglerJsonc<{ triggers?: { crons?: unknown } }>(wranglerPath);

    if (parsed === undefined) {
        return { changed: false, reason: `failed to parse ${wranglerPath} as JSONC`, wranglerPath };
    }

    const existing = Array.isArray(parsed.triggers?.crons)
        ? (parsed.triggers.crons as unknown[]).filter((value): value is string => typeof value === "string")
        : [];

    const generated = [...cronTriggers];
    const managed = readManagedCrons(text) ?? [];
    // Ours-now first, then the user's — an entry that is neither generated now
    // nor generated last time was hand-written and stays.
    const next = [...generated, ...existing.filter((entry) => !generated.includes(entry) && !managed.includes(entry))];

    let edited = text;

    if (!sameTriggers(existing, next)) {
        // Write the array under `triggers.crons`, creating the `triggers` object
        // if absent. `modify` returns minimal edits that keep surrounding comments.
        const edits = modify(text, ["triggers", "crons"], next, { formattingOptions: { insertSpaces: true, tabSize: 4 } });

        if (edits.length === 0) {
            return { changed: false, reason: "no structural edit produced", wranglerPath };
        }

        edited = applyEdits(text, edits);
    }

    const nextText = withMarker(edited, generated);

    // Nothing to do: the wrangler value and the ownership marker already match.
    if (nextText === text) {
        return { changed: false, reason: "triggers.crons already in sync", wranglerPath };
    }

    writeFileSync(wranglerPath, nextText, "utf8");

    return { changed: true, wranglerPath };
};
