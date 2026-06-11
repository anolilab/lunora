/**
 * `cirrus.json` — the optional project config file at the repo root.
 *
 * It is distinct from `wrangler.jsonc` (the Cloudflare worker config): this is
 * Cirrus-level project settings the CLI + Vite plugin read. Today it carries one
 * key, `remote`, which opts the project into remote-binding dev (PLAN5 §5.3)
 * without needing the `--remote` flag or `CIRRUS_REMOTE` env on every run.
 *
 * The file is entirely optional and best-effort: a missing file, malformed
 * JSONC, or an unexpected `remote` value all degrade to "no project preference"
 * rather than throwing, so a typo never breaks `cirrus dev`.
 */
import { existsSync, readFileSync } from "node:fs";

import type { ParseError } from "jsonc-parser";
import { parse as parseJsonc } from "jsonc-parser";

import join from "./path";

/** The canonical project-config filename probed at the project root. */
const CIRRUS_CONFIG_FILE = "cirrus.json";

/**
 * The parsed `remote` preference from `cirrus.json`:
 *
 * - `true` / `false` — the boolean form: enable or explicitly disable remote dev.
 * - `undefined` — no usable preference (file absent, key absent, or malformed).
 *
 * The object form (scoping which binding kinds go remote) is reserved for a
 * future increment; for now an object value is treated as "enabled" (truthy
 * presence) so forward-written configs still turn remote on.
 */
type RemotePreference = boolean | undefined;

/** The structural slice of `cirrus.json` Cirrus reads. */
interface CirrusProjectConfig {
    remote?: unknown;
}

/**
 * Interpret a raw `remote` value into a tri-state preference. A boolean passes
 * through; an object is treated as enabled (the documented-but-not-yet-honored
 * scoping form is still an opt-in); anything else (string, number, null) is no
 * preference.
 */
const interpretRemote = (value: unknown): RemotePreference => {
    if (typeof value === "boolean") {
        return value;
    }

    // Object form (`{ "kinds": [...] }`) is reserved; presence still means "on".
    if (value !== null && typeof value === "object") {
        return true;
    }

    return undefined;
};

/**
 * Read the project's `remote` preference from `cirrus.json`, or `undefined` when
 * there's no usable preference. Best-effort: never throws — a missing file,
 * parse error, or unexpected shape all collapse to `undefined` so the caller
 * falls through to the env/flag layers.
 */
const readProjectRemotePreference = (projectRoot: string): RemotePreference => {
    const configPath = join(projectRoot, CIRRUS_CONFIG_FILE);

    if (!existsSync(configPath)) {
        return undefined;
    }

    let text: string;

    try {
        text = readFileSync(configPath, "utf8");
    } catch {
        return undefined;
    }

    const parseErrors: ParseError[] = [];
    const parsed: unknown = parseJsonc(text, parseErrors, { allowTrailingComma: true });

    if (parseErrors.length > 0 || parsed === null || typeof parsed !== "object") {
        return undefined;
    }

    return interpretRemote((parsed as CirrusProjectConfig).remote);
};

export type { CirrusProjectConfig, RemotePreference };
export { CIRRUS_CONFIG_FILE, interpretRemote, readProjectRemotePreference };
