import { writeFileSync } from "node:fs";

import { applyEdits, modify } from "jsonc-parser";

import type { Manifest } from "./lunora-manifest";
import { formattingFor, readManifest, recordManifestKey } from "./lunora-manifest";
import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";

/** Shallow structural equality for two string arrays (order-sensitive). */
const sameTriggers = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

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

    /**
     * Problems with the ownership record itself, for the caller to `warn`. A
     * damaged `lunora.crons` is not fatal — the reconciler degrades to add-only
     * — but the degradation is invisible: the generated cron it wrote last pass
     * is reported back as hand-written and is then kept for good. Silence is
     * what turns a merge conflict into a permanent orphan.
     */
    warnings: string[];

    /** Resolved wrangler path, or `undefined` when none was found. */
    wranglerPath?: string;
}

/**
 * The cron set this reconciler wrote on its last pass; `[]` when none is
 * recorded, appending to `warnings` when a record IS there but is unusable.
 *
 * Degrading a damaged record to "we own nothing" is the safe direction — the
 * alternative is deleting a trigger on a guess — but it is not a quiet one. A
 * merge conflict or a hand-edit that leaves `lunora.crons` a non-array (or an
 * array with non-string entries) makes the reconciler report the cron it
 * generated itself as hand-written, and by this module's design it is then never
 * cleared again.
 */
const readManagedCrons = (manifest: Manifest | undefined, warnings: string[]): string[] => {
    if (manifest?.lunoraIsForeign === true) {
        warnings.push(
            `${manifest.path}: \`lunora\` is not an object, so the cron ownership record cannot be read or written — a removed cron will keep firing.`,
        );

        return [];
    }

    const recorded = manifest?.lunora?.["crons"];

    if (recorded === undefined) {
        return [];
    }

    if (!Array.isArray(recorded)) {
        warnings.push(
            `${manifest?.path ?? "package.json"}: \`lunora.crons\` is not an array of cron expressions — the crons it recorded are now treated as hand-written and will not be cleared.`,
        );

        return [];
    }

    const managed = recorded.filter((value): value is string => typeof value === "string");

    if (managed.length !== recorded.length) {
        warnings.push(
            `${manifest?.path ?? "package.json"}: \`lunora.crons\` dropped ${String(recorded.length - managed.length)} non-string entry(s) — anything it recorded there is now treated as hand-written and will not be cleared.`,
        );
    }

    return managed;
};

/**
 * Record the set this pass generated, dropping the key — and the `lunora` object
 * with it, when nothing else lives there — once this reconciler owns nothing, so
 * a project with no crons keeps an unmarked manifest.
 */
const recordManagedCrons = (manifest: Manifest, managed: ReadonlyArray<string>): void => {
    recordManifestKey(manifest, "crons", managed.length === 0 ? undefined : [...managed]);
};

/**
 * Reconcile the codegen-derived cron schedules into the project's wrangler
 * config `triggers.crons` array, preserving comments and formatting via
 * `jsonc-parser`'s structural edits.
 *
 * **This does not own the whole array.** Two runtime cron surfaces live on
 * `createWorker` rather than in `lunora/crons.ts`: `backupCron` (the nightly
 * NDJSON backup) and `crons` (handlers keyed by expression). Replacing the array
 * wholesale deleted both on the next `lunora deploy` or dev-server schema save,
 * silently — the nightly backup simply stopped. So an entry this reconciler did
 * not generate is the user's, is kept, and is reported in
 * {@link ReconcileResult.preserved}.
 *
 * Codegen now scans the worker entry for both, so the STATIC case arrives in
 * `cronTriggers` like any declared cron — kept because it is generated, and
 * cleared when the entry stops declaring it. What it cannot resolve is the
 * dynamic case, and that case is supported: `.extend((env) => ({ backupCron:
 * env.NIGHTLY_CRON }))` is the documented escape hatch, and its value exists
 * only at runtime. That residue — plus a computed `crons` key, a spread options
 * object, and anything a project put in `triggers.crons` for its own reasons —
 * is what the preserve rule below is for. It is not redundant with discovery; it
 * is the half discovery provably cannot reach.
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
        return { changed: false, preserved: [], reason: "wrangler.jsonc not found", warnings: [] };
    }

    const { parsed, text } = readWranglerJsonc<{ triggers?: { crons?: unknown } }>(wranglerPath);

    if (parsed === undefined) {
        return { changed: false, preserved: [], reason: `failed to parse ${wranglerPath} as JSONC`, warnings: [], wranglerPath };
    }

    const existing = Array.isArray(parsed.triggers?.crons)
        ? (parsed.triggers.crons as unknown[]).filter((value): value is string => typeof value === "string")
        : [];

    const generated = [...cronTriggers];
    const warnings: string[] = [];
    const manifest = readManifest(projectRoot);
    const managed = readManagedCrons(manifest, warnings);
    // An entry that is neither generated now nor generated last time was
    // hand-written and stays — after the ones we own, in the order codegen emits.
    const preserved = existing.filter((entry) => !generated.includes(entry) && !managed.includes(entry));
    const next = [...generated, ...preserved];

    // Ownership is recorded AFTER the config is written, never before. This used
    // to run first, so a manifest `modify` that threw took the wrangler write down
    // with it: both callers swallow the throw into one `warn` line, and the deploy
    // shipped `triggers.crons: []` with every scheduled function silently dead.
    const record = (): void => {
        if (manifest !== undefined) {
            recordManagedCrons(manifest, generated);
        }
    };

    if (sameTriggers(existing, next)) {
        record();

        return { changed: false, preserved, reason: "triggers.crons already in sync", warnings, wranglerPath };
    }

    // `modify` returns minimal edits that keep surrounding comments, and creates
    // the `triggers` object when it is absent.
    const edits = modify(text, ["triggers", "crons"], next, { formattingOptions: formattingFor(text) });

    if (edits.length === 0) {
        return { changed: false, preserved, reason: "no structural edit produced", warnings, wranglerPath };
    }

    writeFileSync(wranglerPath, applyEdits(text, edits), "utf8");

    // Only once the config is on disk. Recording ownership the config does not
    // reflect would let the next pass clear a cron that is still declared.
    record();

    return { changed: true, preserved, warnings, wranglerPath };
};

/**
 * The one log line worth printing for a reconcile that kept entries it does not
 * own, or `undefined` when it owned the whole array. Lives here rather than in
 * each caller because `lunora deploy` and the Vite plugin print it verbatim and
 * had already drifted into two copies of the same sentence.
 */
const describePreservedCrons = (preserved: ReadonlyArray<string>): string | undefined =>
    preserved.length === 0 ? undefined : `kept ${String(preserved.length)} hand-written cron trigger(s): ${preserved.join(", ")}`;

export type { ReconcileResult };
export { describePreservedCrons, reconcileWranglerCrons };
