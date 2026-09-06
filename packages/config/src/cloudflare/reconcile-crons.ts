import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { FormattingOptions } from "jsonc-parser";
import { applyEdits, modify } from "jsonc-parser";

import join from "../path";
import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";

/** Shallow structural equality for two string arrays (order-sensitive). */
const sameTriggers = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

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

interface ReconcileResult {
    /** `true` when the wrangler config's `triggers.crons` was rewritten. */
    changed: boolean;

    /**
     * Entries left in `triggers.crons` that this reconciler did not generate and
     * does not own — a hand-written `backupCron` trigger, or anything already
     * there before ownership was first recorded. Non-empty means the array is
     * NOT the codegen-derived set, which is the surprising half of what this
     * does and the one thing worth printing.
     */
    preserved: string[];

    /** Human-readable reason when reconciliation was skipped (for logging). */
    reason?: string;

    /** Resolved wrangler path, or `undefined` when none was found. */
    wranglerPath?: string;
}

interface Manifest {
    /** The manifest's `lunora` value, when it has one and it is an object. */
    lunora: Record<string, unknown> | undefined;
    path: string;
    text: string;
}

/**
 * The project manifest, or `undefined` when it is missing or is not readable
 * JSON.
 *
 * Unreadable reads as "no ownership recorded" rather than throwing: this runs
 * inside a deploy and inside every dev-server schema save, where a manifest that
 * broken already fails for reasons that have nothing to do with cron triggers.
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

        return { lunora: isObject ? (lunora as Record<string, unknown>) : undefined, path, text };
    } catch {
        return undefined;
    }
};

/** The cron set this reconciler wrote on its last pass; `[]` when none is recorded. */
const readManagedCrons = (manifest: Manifest | undefined): string[] => {
    const recorded = manifest?.lunora?.["crons"];

    return Array.isArray(recorded) ? recorded.filter((value): value is string => typeof value === "string") : [];
};

/**
 * Record the set this pass generated, dropping the key — and the `lunora` object
 * with it, when nothing else lives there — once this reconciler owns nothing, so
 * a project with no crons keeps an unmarked manifest.
 */
const recordManagedCrons = (manifest: Manifest, managed: ReadonlyArray<string>): void => {
    const clearing = managed.length === 0;
    const path = clearing && Object.keys(manifest.lunora ?? {}).length <= 1 ? ["lunora"] : ["lunora", "crons"];
    const edits = modify(manifest.text, path, clearing ? undefined : [...managed], { formattingOptions: formattingFor(manifest.text) });

    if (edits.length === 0) {
        return;
    }

    const next = applyEdits(manifest.text, edits);

    if (next !== manifest.text) {
        writeFileSync(manifest.path, next, "utf8");
    }
};

/**
 * Reconcile the codegen-derived cron schedules into the project's wrangler
 * config `triggers.crons` array, preserving comments and formatting via
 * `jsonc-parser`'s structural edits.
 *
 * **This does not own the whole array.** Two runtime cron surfaces are invisible
 * to codegen and are documented as needing a hand-written `triggers.crons` entry:
 * `createWorker({ backupCron })` (the nightly NDJSON backup) and
 * `createWorker({ crons })` (handlers keyed by expression). Replacing the array
 * wholesale deleted both on the next `lunora deploy` or dev-server schema save,
 * silently — the nightly backup simply stopped. So an entry this reconciler did
 * not generate is the user's, is kept, and is reported in
 * {@link ReconcileResult.preserved}.
 *
 * Ownership is recorded in the project's `package.json` under `lunora.crons`,
 * which is why a REMOVED generated cron still gets cleared (it is in the record
 * and no longer in `cronTriggers`) while a hand-written one never is. Three
 * properties pick that location:
 *
 * COMMITTED, so it survives a fresh clone. Gitignored `.lunora/` state does not:
 * a CI-only deploy finds none, and falling back to add-only there leaves a
 * removed cron firing forever.
 *
 * VALID JSON, so `wrangler.json` — a supported config name — behaves exactly like
 * `wrangler.jsonc`. A `//` marker inside the config does not: wrangler tolerates
 * one in either (both go through its JSONC parser), but the project's own
 * `JSON.parse`, its deploy wrapper and its editor's JSON schema validation all
 * break the moment a `.json` grows a comment. Nor can the record be a plain key
 * in the wrangler config — wrangler reports unknown fields ("Unexpected fields
 * found in top-level field") on every command.
 *
 * READ AND WRITTEN AT ONE ADDRESS. A comment has to be found textually on the way
 * in and positioned structurally on the way out, and those are not the same
 * place: a stale duplicate higher in the file was read as the record and deleted
 * the user's backup trigger.
 *
 * The wrangler config is rewritten only when an entry actually moves, so
 * {@link ReconcileResult.changed} means what a `synced N cron trigger(s)` log
 * claims it means.
 *
 * A project with nothing recorded yet — one predating this, or one with no
 * manifest — treats every entry as the user's, which is the safe direction: a
 * wrongly-kept trigger costs one no-op invocation, a wrongly-deleted one
 * silently ends the backups. It becomes precise after a codegen run that still
 * declares the cron; upgrading and deleting a cron in the same change records an
 * empty set, and that orphan is then kept for good.
 *
 * This intentionally writes the SAME `triggers.crons` shape the
 * `@lunora/config` validator accepts, so the wrangler validator never fights the
 * generated value.
 */
const reconcileWranglerCrons = (projectRoot: string, cronTriggers: ReadonlyArray<string>): ReconcileResult => {
    const wranglerPath = findWranglerFile(projectRoot);

    if (!wranglerPath) {
        return { changed: false, preserved: [], reason: "wrangler.jsonc not found" };
    }

    const { parsed, text } = readWranglerJsonc<{ triggers?: { crons?: unknown } }>(wranglerPath);

    if (parsed === undefined) {
        return { changed: false, preserved: [], reason: `failed to parse ${wranglerPath} as JSONC`, wranglerPath };
    }

    const existing = Array.isArray(parsed.triggers?.crons)
        ? (parsed.triggers.crons as unknown[]).filter((value): value is string => typeof value === "string")
        : [];

    const generated = [...cronTriggers];
    const manifest = readManifest(projectRoot);
    const managed = readManagedCrons(manifest);
    // An entry that is neither generated now nor generated last time was
    // hand-written and stays — after the ones we own, in the order codegen emits.
    const preserved = existing.filter((entry) => !generated.includes(entry) && !managed.includes(entry));
    const next = [...generated, ...preserved];

    if (manifest !== undefined) {
        recordManagedCrons(manifest, generated);
    }

    if (sameTriggers(existing, next)) {
        return { changed: false, preserved, reason: "triggers.crons already in sync", wranglerPath };
    }

    // `modify` returns minimal edits that keep surrounding comments, and creates
    // the `triggers` object when it is absent.
    const edits = modify(text, ["triggers", "crons"], next, { formattingOptions: formattingFor(text) });

    if (edits.length === 0) {
        return { changed: false, preserved, reason: "no structural edit produced", wranglerPath };
    }

    writeFileSync(wranglerPath, applyEdits(text, edits), "utf8");

    return { changed: true, preserved, wranglerPath };
};

export type { ReconcileResult };
export { reconcileWranglerCrons };
