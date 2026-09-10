/**
 * `lunora.config.*` — the optional project config file at the repo root.
 *
 * It is distinct from `wrangler.jsonc` (the Cloudflare worker config): this is
 * Lunora-level project settings the CLI + Vite plugin read. It carries `remote`,
 * which opts the project into remote-binding dev (PLAN5 §5.3) without needing
 * the `--remote` flag or `LUNORA_REMOTE` env on every run, `target`, which
 * selects the deploy target (plan 114 §5.3/§5.5), and `app`, the hook a
 * Vite-first project composes its generated worker entry with.
 *
 * It replaces `lunora.json`. The two were always the same question — "how is
 * this project wired?" — split across a format boundary that existed only
 * because the CLI could not read TypeScript. It can now: `@lunora/codegen` owns
 * one `jiti`-backed loader for the file, and this module reads `remote` off it.
 *
 * The file is entirely optional and best-effort: a missing file, a config that
 * throws, or an unexpected `remote` value all degrade to "no project preference"
 * rather than throwing, so a typo never breaks `lunora dev`.
 */
import { PROJECT_CONFIG_BASENAME, PROJECT_CONFIG_EXTENSIONS, readProjectConfigLiterals, readProjectTarget as readCodegenProjectTarget } from "@lunora/codegen";

import { DEFAULT_DEPLOY_TARGET, resolveDeployDriver } from "./driver-registry";

/**
 * The project-config filenames probed at the project root, in order — the same
 * set the loader in `@lunora/codegen` resolves, re-exported here because the dev
 * server watches and fingerprints them.
 */
const LUNORA_CONFIG_FILES: string[] = PROJECT_CONFIG_EXTENSIONS.map((extension) => `${PROJECT_CONFIG_BASENAME}${extension}`);

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
 * Read the project's `remote` preference, or `undefined` when there is no
 * usable one — the caller then falls through to the env/flag layers.
 */
const readProjectRemotePreference = (projectRoot: string): RemotePreference => interpretRemote(readProjectConfigLiterals(projectRoot).remote);

/**
 * Read the project's deploy `target` from `lunora.json`, or `undefined` when
 * absent.
 *
 * Delegates to `@lunora/codegen` rather than re-reading the file here.
 * `runCodegen` has to resolve the same key without this package (config
 * depends on codegen, not the reverse), so the parser lives there and this is a
 * re-export — two readers of one key is exactly the kind of copy that drifts.
 */
const readProjectTarget = (projectRoot: string): string | undefined => readCodegenProjectTarget(projectRoot);

/**
 * Resolve the deploy target for a command: an explicit `--target` wins, then
 * `lunora.json`, then the registry default.
 *
 * **This is the canonical resolution point, and the reason it is one place.**
 * Codegen tailors the emitted `ctx.*` surface to a target while deploy picks
 * the driver that ships it. Resolve those separately and they can disagree,
 * producing an app that builds cleanly and fails at runtime with nothing in the
 * build to explain it. Every caller — CLI commands, the Vite plugin,
 * `runCodegen`'s own fallback — resolves through here or through
 * {@link resolveTargetOrThrow}, so there is exactly one precedence order to
 * reason about.
 */
const resolveProjectTarget = (projectRoot: string, explicit?: string): string => explicit ?? readProjectTarget(projectRoot) ?? DEFAULT_DEPLOY_TARGET;

/**
 * Resolve the deploy target as {@link resolveProjectTarget} does, then reject
 * one that no registered driver serves.
 *
 * Lives here rather than in `@lunora/cli` because nothing about it is
 * CLI-shaped and the Vite plugin needs the same guard — a validator only the
 * CLI could reach left `vite build` emitting the default surface for a
 * mis-declared target, silently.
 *
 * Callers that go on to resolve a driver get this for free; the ones that never
 * look a driver up — codegen, the Vite plugin — need it, because otherwise
 * nothing in their path ever rejects the name.
 * @param projectRoot Directory containing `lunora.json`.
 * @param explicit A caller-supplied target, if any.
 * @throws when the resolved target names no registered driver.
 * @returns the resolved, registered target id.
 */
const resolveTargetOrThrow = (projectRoot: string, explicit?: string): string => {
    const target = resolveProjectTarget(projectRoot, explicit);

    // Resolved purely to validate — the driver itself is the caller's business.
    resolveDeployDriver(target);

    return target;
};

export type { LunoraProjectConfig, RemotePreference };
export { interpretRemote, LUNORA_CONFIG_FILES, readProjectRemotePreference, readProjectTarget, resolveProjectTarget, resolveTargetOrThrow };
