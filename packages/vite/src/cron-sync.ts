import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ParseError } from "jsonc-parser";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";

/** Candidate wrangler config filenames, in the order the CLI / validator probe them. */
const WRANGLER_FILES = ["wrangler.jsonc", "wrangler.json"] as const;

const findWranglerFile = (projectRoot: string): string | undefined => {
    for (const candidate of WRANGLER_FILES) {
        const fullPath = join(projectRoot, candidate);

        if (existsSync(fullPath)) {
            return fullPath;
        }
    }

    return undefined;
};

/** Shallow structural equality for two string arrays (order-sensitive). */
const sameTriggers = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

export interface ReconcileResult {
    /** `true` when `wrangler.jsonc` was rewritten. */
    changed: boolean;
    /** Human-readable reason when reconciliation was skipped (for logging). */
    reason?: string;
    /** Resolved wrangler path, or `undefined` when none was found. */
    wranglerPath?: string;
}

/**
 * Reconcile the codegen-derived cron schedules into the project's
 * `wrangler.jsonc` `triggers.crons` array, preserving comments and formatting
 * via `jsonc-parser`'s structural edits.
 *
 * When `triggers.crons` already matches `cronTriggers`, nothing is written (so
 * we don't churn the file or trip the dev server's file watcher). When the
 * project declares no crons, a stale non-empty array is cleared so removed
 * crons stop firing.
 *
 * This intentionally writes the SAME `triggers.crons` shape the
 * `@cirrus/config` validator accepts, so the wrangler validator never fights
 * the generated value.
 */
export const reconcileWranglerCrons = (projectRoot: string, cronTriggers: ReadonlyArray<string>): ReconcileResult => {
    const wranglerPath = findWranglerFile(projectRoot);

    if (!wranglerPath) {
        return { changed: false, reason: "wrangler.jsonc not found" };
    }

    const text = readFileSync(wranglerPath, "utf8");
    const parseErrors: ParseError[] = [];
    const parsed = parseJsonc(text, parseErrors, { allowTrailingComma: true }) as { triggers?: { crons?: unknown } } | undefined;

    if (parseErrors.length > 0 || !parsed || typeof parsed !== "object") {
        return { changed: false, reason: `failed to parse ${wranglerPath} as JSONC`, wranglerPath };
    }

    const existing = Array.isArray(parsed.triggers?.crons)
        ? (parsed.triggers.crons as unknown[]).filter((value): value is string => typeof value === "string")
        : [];

    // Nothing to do: the wrangler value already matches the generated set.
    if (sameTriggers(existing, cronTriggers)) {
        return { changed: false, reason: "triggers.crons already in sync", wranglerPath };
    }

    // Write the array under `triggers.crons`, creating the `triggers` object if
    // absent. `modify` returns minimal edits that keep surrounding comments.
    const edits = modify(text, ["triggers", "crons"], [...cronTriggers], {
        formattingOptions: { insertSpaces: true, tabSize: 4 },
    });

    if (edits.length === 0) {
        return { changed: false, reason: "no structural edit produced", wranglerPath };
    }

    writeFileSync(wranglerPath, applyEdits(text, edits), "utf8");

    return { changed: true, wranglerPath };
};
