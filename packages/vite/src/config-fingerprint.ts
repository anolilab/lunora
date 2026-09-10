import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { findProjectConfigFile } from "@lunora/codegen";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

/**
 * Fingerprint one JSONC config file for drift detection. Parses first (so
 * comment/whitespace-only edits don't count), applies an optional `normalize`
 * over the parsed object, and stringifies. A transient unparseable read
 * (mid-write) keys off the raw text so it doesn't momentarily look like a
 * different, restart-worthy shape; a genuinely unreadable file is a stable
 * `"unreadable"`. Shared by both config files so their parse/normalize path is
 * identical.
 */
const fingerprintJsonc = (filePath: string, normalize?: (parsed: Record<string, unknown>) => Record<string, unknown>): string => {
    try {
        const { parsed, text } = readWranglerJsonc<Record<string, unknown>>(filePath);

        if (parsed === undefined) {
            return `raw:${text}`;
        }

        return JSON.stringify(normalize ? normalize(parsed) : parsed);
    } catch {
        return "unreadable";
    }
};

/**
 * Strip the codegen-owned `triggers.crons` key from a parsed `wrangler.jsonc`:
 * `reconcileWranglerCrons` rewrites it on every schema save, and those writes
 * must never read as external drift and trigger a restart loop.
 *
 * Crucially, an emptied `triggers` is dropped ENTIRELY rather than left as `{}`:
 * adding the FIRST cron turns "no `triggers` key" into "`triggers` with only
 * `crons`", and both must normalize to the same fingerprint — otherwise the very
 * first cron a project adds would read as drift and spuriously restart the dev
 * server. Any other `triggers.*` key (a user-authored trigger) is preserved.
 */
const stripCodegenOwnedCrons = (parsed: Record<string, unknown>): Record<string, unknown> => {
    const clone: Record<string, unknown> = { ...parsed };
    const { triggers } = clone;

    if (triggers !== null && typeof triggers === "object") {
        const restTriggers: Record<string, unknown> = { ...(triggers as Record<string, unknown>) };

        delete restTriggers.crons;

        if (Object.keys(restTriggers).length > 0) {
            clone.triggers = restTriggers;
        } else {
            delete clone.triggers;
        }
    }

    return clone;
};

/**
 * A stable fingerprint of the binding-relevant slice of the project's config
 * files (`wrangler.jsonc` + `lunora.config.*`), used by the dev config-drift
 * watcher to tell a real, restart-worthy edit apart from codegen's own
 * idempotent writes.
 *
 * The wrangler part strips the codegen-owned `triggers.crons` (see
 * {@link stripCodegenOwnedCrons}). Watching a file without fingerprinting it
 * makes the watcher inert: `onConfigChange` returns early when the fingerprint
 * has not moved.
 *
 * The parts are joined with a NUL — a control char `JSON.stringify` never emits,
 * so no part can forge a boundary. It is written as the `\u0000` escape, NOT a
 * raw byte: a literal NUL makes this source file read as binary to
 * grep/gitleaks. Keep the escape.
 */
const computeConfigFingerprint = (projectRoot: string): string => {
    const wranglerFile = findWranglerFile(projectRoot);
    const wranglerPart = wranglerFile === undefined ? "absent" : fingerprintJsonc(wranglerFile, stripCodegenOwnedCrons);

    // Hashed by CONTENT, not parsed: `lunora.config.*` is TypeScript, and the
    // composed class-A entry embeds whichever builder calls its `app` hook makes,
    // so any edit is restart-worthy. Absent or unreadable is "absent" — there is
    // nothing to restart on, and the next successful read moves the fingerprint.
    const lunoraConfigPath = findProjectConfigFile(projectRoot);
    let lunoraPart = "absent";

    try {
        if (lunoraConfigPath !== undefined) {
            lunoraPart = createHash("sha256").update(readFileSync(lunoraConfigPath)).digest("hex");
        }
    } catch {
        // Left "absent".
    }

    return `${wranglerPart}\u0000${lunoraPart}`;
};

export { computeConfigFingerprint, fingerprintJsonc, stripCodegenOwnedCrons };
