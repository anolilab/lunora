import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseDevVariableEntries } from "../dev-variables-format";

/**
 * Parse a single `KEY=value` (optionally quoted) out of a `.dev.vars` body,
 * returning `undefined` when the key is absent or its value is empty. A thin
 * wrapper over {@link parseDevVariableEntries} — the single owner of the
 * `.dev.vars` line grammar — so the key-validation, comment-skip, and quote-strip
 * rules can't drift from every other reader/writer of the file.
 */
export const parseDevVariable = (contents: string, key: string): string | undefined => {
    const entry = parseDevVariableEntries(contents).find((candidate) => candidate.key === key);

    return entry === undefined || entry.value === "" ? undefined : entry.value;
};

/**
 * Resolve the worker's admin token so the studio can auto-authenticate in dev.
 *
 * The ONLY source is the project's `.dev.vars` — the file
 * `@cloudflare/vite-plugin` / `wrangler dev` feed the local worker, and
 * therefore the only token the worker's admin gate can verify. A shell-exported
 * `LUNORA_ADMIN_TOKEN` (the documented way to run `lunora backup` /
 * `lunora deploy --migrate` against **production**) never reaches the local
 * worker's `env`, so embedding it would both fail the gate and put a production
 * bearer into every `/__lunora` document served on the developer's machine.
 * When the two disagree we say so once and keep using `.dev.vars`.
 *
 * Returns `undefined` when `.dev.vars` carries no token (the studio then prompts).
 */
export const resolveAdminToken = (root: string): string | undefined => {
    let fromDevVariables: string | undefined;

    try {
        fromDevVariables = parseDevVariable(readFileSync(join(root, ".dev.vars"), "utf8"), "LUNORA_ADMIN_TOKEN");
    } catch {
        fromDevVariables = undefined;
    }

    const fromEnvironment = process.env["LUNORA_ADMIN_TOKEN"];

    if (typeof fromEnvironment === "string" && fromEnvironment !== "" && fromEnvironment !== fromDevVariables) {
        // Not rate-limited on purpose: each host resolves the token once per dev
        // session (the document is built once and cached), so this is one line.
        // eslint-disable-next-line no-console -- dev-host notice; the studio hosts have no shared logger at this seam.
        console.warn(
            "[lunora] LUNORA_ADMIN_TOKEN is exported in this shell but differs from .dev.vars — the local worker only verifies the .dev.vars token, so the studio uses that one.",
        );
    }

    return fromDevVariables;
};
