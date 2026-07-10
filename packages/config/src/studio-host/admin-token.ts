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
 * Resolve the worker's admin token so the studio can auto-authenticate in
 * dev. Prefers the `LUNORA_ADMIN_TOKEN` env var, then the project's `.dev.vars`
 * — the same file `@cloudflare/vite-plugin` / `wrangler dev` feed the worker, so
 * the token the studio sends matches the one the worker's admin gate
 * verifies. Returns `undefined` when neither is set (the studio then prompts).
 */
export const resolveAdminToken = (root: string): string | undefined => {
    const fromEnv = process.env["LUNORA_ADMIN_TOKEN"];

    if (typeof fromEnv === "string" && fromEnv !== "") {
        return fromEnv;
    }

    try {
        return parseDevVariable(readFileSync(join(root, ".dev.vars"), "utf8"), "LUNORA_ADMIN_TOKEN");
    } catch {
        return undefined;
    }
};
