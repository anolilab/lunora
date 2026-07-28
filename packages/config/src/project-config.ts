/**
 * `lunora.json` — the optional project config file at the repo root.
 *
 * It is distinct from `wrangler.jsonc` (the Cloudflare worker config): this is
 * Lunora-level project settings the CLI + Vite plugin read. It carries `remote`,
 * which opts the project into remote-binding dev (PLAN5 §5.3) without needing
 * the `--remote` flag or `LUNORA_REMOTE` env on every run, and `target`, which
 * selects the deploy target (plan 114 §5.3/§5.5).
 *
 * The file is entirely optional and best-effort: a missing file, malformed
 * JSONC, or an unexpected `remote` value all degrade to "no project preference"
 * rather than throwing, so a typo never breaks `lunora dev`.
 */
import { existsSync, readFileSync } from "node:fs";

import type { ParseError } from "jsonc-parser";
import { parse as parseJsonc } from "jsonc-parser";

import { DEFAULT_DEPLOY_TARGET } from "./driver-registry";
import join from "./path";

/** The canonical project-config filename probed at the project root. */
const LUNORA_CONFIG_FILE = "lunora.json";

/**
 * The parsed `remote` preference from `lunora.json`:
 *
 * - `true` / `false` — the boolean form: enable or explicitly disable remote dev.
 * - `undefined` — no usable preference (file absent, key absent, or malformed).
 *
 * The object form (scoping which binding kinds go remote) is reserved for a
 * future increment; for now an object value is treated as "enabled" (truthy
 * presence) so forward-written configs still turn remote on.
 */
type RemotePreference = boolean | undefined;

/** The structural slice of `lunora.json` Lunora reads. */
interface LunoraProjectConfig {
    remote?: unknown;
    target?: unknown;
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
 * Read the project's `remote` preference from `lunora.json`, or `undefined` when
 * there's no usable preference. Best-effort: never throws — a missing file,
 * parse error, or unexpected shape all collapse to `undefined` so the caller
 * falls through to the env/flag layers.
 */
const readProjectConfig = (projectRoot: string): LunoraProjectConfig | undefined => {
    const configPath = join(projectRoot, LUNORA_CONFIG_FILE);

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

    return parsed;
};

const readProjectRemotePreference = (projectRoot: string): RemotePreference => interpretRemote(readProjectConfig(projectRoot)?.remote);

/**
 * Read the project's deploy `target` from `lunora.json`, or `undefined` when
 * absent.
 *
 * Deliberately NOT validated here. An unknown name must reach
 * `resolveDeployDriver`, which throws and lists the registered targets —
 * treating a typo as "no preference" would silently deploy to Cloudflare
 * because `"clouflare"` was not recognized, which is the one failure mode
 * target selection must never have. Only a non-string (or absent) value
 * collapses to `undefined`, since that is a shape error rather than a name the
 * user meant.
 */
const readProjectTarget = (projectRoot: string): string | undefined => {
    const { target } = readProjectConfig(projectRoot) ?? {};

    return typeof target === "string" && target.length > 0 ? target : undefined;
};

/**
 * Resolve the deploy target for a command: an explicit `--target` wins, then
 * `lunora.json`, then the registry default.
 *
 * One resolution point on purpose. Codegen tailors the emitted `ctx.*` surface
 * to a target while deploy picks the driver that ships it — resolving those
 * separately lets them disagree, and an app generated for one provider and
 * deployed to another fails at runtime with nothing in the build to explain it.
 */
const resolveProjectTarget = (projectRoot: string, explicit?: string): string => explicit ?? readProjectTarget(projectRoot) ?? DEFAULT_DEPLOY_TARGET;

export type { LunoraProjectConfig, RemotePreference };
export { interpretRemote, LUNORA_CONFIG_FILE, readProjectRemotePreference, readProjectTarget, resolveProjectTarget };
