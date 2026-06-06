import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Split on CRLF or LF line endings; module-scoped so it isn't recompiled per call. */
const LINE_BREAK = /\r?\n/u;

/** Parse a single `KEY=value` (optionally quoted) out of a `.dev.vars` body. */
export const parseDevVariable = (contents: string, key: string): string | undefined => {
    for (const raw of contents.split(LINE_BREAK)) {
        const line = raw.trim();
        const eq = line.indexOf("=");

        if (line === "" || line.startsWith("#") || eq === -1 || line.slice(0, eq).trim() !== key) {
            continue;
        }

        const value = line.slice(eq + 1).trim();
        const unquoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")) ? value.slice(1, -1) : value;

        return unquoted === "" ? undefined : unquoted;
    }

    return undefined;
};

/**
 * Resolve the worker's admin token so the dashboard can auto-authenticate in
 * dev. Prefers the `CIRRUS_ADMIN_TOKEN` env var, then the project's `.dev.vars`
 * — the same file `@cloudflare/vite-plugin` / `wrangler dev` feed the worker, so
 * the token the dashboard sends matches the one the worker's admin gate
 * verifies. Returns `undefined` when neither is set (the dashboard then prompts).
 */
export const resolveAdminToken = (root: string): string | undefined => {
    const fromEnv = process.env["CIRRUS_ADMIN_TOKEN"];

    if (typeof fromEnv === "string" && fromEnv !== "") {
        return fromEnv;
    }

    try {
        return parseDevVariable(readFileSync(join(root, ".dev.vars"), "utf8"), "CIRRUS_ADMIN_TOKEN");
    } catch {
        return undefined;
    }
};
