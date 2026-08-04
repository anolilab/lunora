/**
 * `.lunora/project.json` — the per-checkout link between a working copy and its
 * deployed Cloudflare Worker.
 *
 * This mirrors Vercel's `.vercel/project.json`: a small, machine-specific,
 * gitignored file that records the deployed worker's name + public URL (and the
 * optional Cloudflare environment) so CLI commands that target a live worker —
 * `deploy --migrate`, `logs`, `run`, `insights`, the deploy summary — no longer
 * need `--url`/`--name` re-typed on every invocation.
 *
 * It is deliberately distinct from `lunora.json` (committed project settings)
 * and from `wrangler.jsonc` (Cloudflare worker config). It carries no secrets —
 * only public identifiers — so even though it is gitignored by convention, an
 * accidental commit leaks nothing sensitive.
 *
 * Every read is best-effort: a missing file, malformed JSON, or unexpected
 * shape all collapse to `undefined` so a stale link never throws mid-command.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { ParseError } from "jsonc-parser";
import { parse as parseJsonc } from "jsonc-parser";

import join from "./path";

/** Directory holding per-checkout Lunora state (gitignored by convention). */
const LINKED_PROJECT_DIR = ".lunora";

/** The canonical link filename, relative to the project root. */
const LINKED_PROJECT_FILE: string = join(LINKED_PROJECT_DIR, "project.json");

/**
 * The link record persisted to `.lunora/project.json`. Every field is optional
 * so a partially-populated link (e.g. a worker name with no URL yet) still
 * round-trips. `linkedAt` is an ISO-8601 stamp written at link time, purely
 * informational.
 */
interface LinkedProject {
    /** Cloudflare account id the worker lives under, when known. */
    account?: string;
    /** Cloudflare environment name (`wrangler … --env <env>`), when scoped. */
    env?: string;
    /** ISO-8601 timestamp recorded when the link was written. */
    linkedAt?: string;
    /** The deployed Worker's name (matches `name` in wrangler config). */
    workerName?: string;
    /** The deployed Worker's public URL (e.g. `https://app.acme.workers.dev`). */
    workerUrl?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";

/** Read a string field, returning `undefined` for absent/empty/non-string. */
const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
    const value = record[key];

    return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * Read the link record from `.lunora/project.json`, or `undefined` when there
 * is no usable link. Best-effort: a missing file, parse error, or unexpected
 * shape all collapse to `undefined`.
 */
const readLinkedProject = (projectRoot: string): LinkedProject | undefined => {
    const path = join(projectRoot, LINKED_PROJECT_FILE);

    if (!existsSync(path)) {
        return undefined;
    }

    let text: string;

    try {
        text = readFileSync(path, "utf8");
    } catch {
        return undefined;
    }

    const parseErrors: ParseError[] = [];
    const parsed: unknown = parseJsonc(text, parseErrors, { allowTrailingComma: true });

    if (parseErrors.length > 0 || !isObject(parsed)) {
        return undefined;
    }

    return {
        account: stringField(parsed, "account"),
        env: stringField(parsed, "env"),
        linkedAt: stringField(parsed, "linkedAt"),
        workerName: stringField(parsed, "workerName"),
        workerUrl: stringField(parsed, "workerUrl"),
    };
};

/**
 * Write the link record to `.lunora/project.json`, creating the `.lunora/`
 * directory when absent. Only defined fields are persisted (so an empty value
 * never clobbers a known one). Returns the absolute path written.
 */
const writeLinkedProject = (projectRoot: string, link: LinkedProject): string => {
    const directory = join(projectRoot, LINKED_PROJECT_DIR);

    mkdirSync(directory, { recursive: true });

    const record: Record<string, string> = {};

    for (const key of ["account", "env", "linkedAt", "workerName", "workerUrl"] as const) {
        const value = link[key];

        if (value !== undefined && value !== "") {
            record[key] = value;
        }
    }

    const path = join(projectRoot, LINKED_PROJECT_FILE);

    writeFileSync(path, `${JSON.stringify(record, undefined, 2)}\n`, "utf8");

    return path;
};

export type { LinkedProject };
export { LINKED_PROJECT_DIR, LINKED_PROJECT_FILE, readLinkedProject, writeLinkedProject };
