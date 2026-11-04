/**
 * An eager check of the project's `defineEnv` contract (`lunora/env.ts`) against
 * the values a local dev worker boots with.
 *
 * `defineEnv` validates lazily, per key, on first read — the right model inside a
 * Worker, where an unused key must not fail a request that never touches it. It
 * also means a missing or malformed value surfaces as a 500 from whichever request
 * first reads it. Running the contract's eager `.parse` at dev start turns that
 * into a startup warning. A warning, never a failure: a half-filled `.dev.vars` is
 * a normal state while working on one part of an app.
 *
 * The env is assembled the way `wrangler dev` / `@cloudflare/vite-plugin` do it:
 * the top-level wrangler `vars`, overlaid with `.dev.vars` — or, when there is no
 * `.dev.vars`, with `.env` and `.env.local`. The shell environment is NOT merged:
 * the worker does not see it, so merging it would hide a key the worker lacks.
 */
import { existsSync, readFileSync } from "node:fs";

import type { ManifestConfigShape } from "./cloudflare/binding-manifest";
import { buildBindingManifest } from "./cloudflare/binding-manifest";
import { findWranglerFile, readWranglerJsonc } from "./cloudflare/wrangler-path";
import { DEV_VARS_FILE, parseDevVariableEntries } from "./dev-variables-format";
import join from "./path";

/** The one file a `defineEnv` contract may live in — mirrors codegen's `ENV_FILENAME`. */
const ENV_FILENAME = "env.ts";

/** One key the contract rejected; `message` is already redacted by `defineEnv`. */
interface DevEnvFailure {
    key: string;
    message: string;
}

/** What {@link checkDevEnv} found. */
type DevEnvCheck =
    | { error: string; kind: "unloadable" }
    | { failures: DevEnvFailure[]; kind: "invalid"; sources: string[] }
    | { kind: "absent" }
    | { kind: "valid" };

interface DevEnvCheckOptions {
    /**
     * Imports `lunora/env.ts` and answers its module namespace. Defaults to a
     * cache-free `jiti` import, so an edited contract is read fresh.
     */
    load?: (path: string) => Promise<unknown>;
    projectRoot: string;
    schemaDirectory: string;
}

/** A `defineEnv` accessor, recognised by shape: `@lunora/server` is not a dependency here. */
type EnvAccessorLike = ((env: unknown) => unknown) & { parse: (env: unknown) => unknown };

const isAccessor = (value: unknown): value is EnvAccessorLike => typeof value === "function" && typeof (value as { parse?: unknown }).parse === "function";

const defaultLoad = async (path: string): Promise<unknown> => {
    const { createJiti } = await import("jiti");

    return createJiti(path, { interopDefault: false, moduleCache: false }).import(path);
};

const readDotenvFile = (path: string): Record<string, string> | undefined =>
    existsSync(path) ? Object.fromEntries(parseDevVariableEntries(readFileSync(path, "utf8")).map(({ key, value }) => [key, value])) : undefined;

/** The worker's local env: wrangler `vars`, then the dev-vars files; plus the names its bindings take. */
const localWorkerEnv = (projectRoot: string): { bindingNames: Set<string>; env: Record<string, unknown>; sources: string[] } => {
    const env: Record<string, unknown> = {};
    const sources: string[] = [];
    let bindingNames = new Set<string>();
    const wranglerPath = findWranglerFile(projectRoot);
    const parsed = wranglerPath === undefined ? undefined : readWranglerJsonc<ManifestConfigShape & { vars?: Record<string, unknown> }>(wranglerPath).parsed;

    if (parsed !== undefined) {
        Object.assign(env, parsed.vars ?? {});
        sources.push("wrangler vars");
        bindingNames = new Set(buildBindingManifest(parsed).bindings.map((requirement) => requirement.binding));
    }

    const devVariables = readDotenvFile(join(projectRoot, DEV_VARS_FILE));

    if (devVariables === undefined) {
        for (const file of [".env", ".env.local"]) {
            const values = readDotenvFile(join(projectRoot, file));

            if (values !== undefined) {
                Object.assign(env, values);
                sources.push(file);
            }
        }
    } else {
        Object.assign(env, devVariables);
        sources.push(DEV_VARS_FILE);
    }

    return { bindingNames, env, sources };
};

const failuresOf = (error: unknown): DevEnvFailure[] | undefined => {
    const failures = (error as { failures?: unknown } | undefined)?.failures;

    return Array.isArray(failures) ? (failures as DevEnvFailure[]) : undefined;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Run the project's env contract against its local worker env. Never throws: a
 * contract that cannot be loaded on the host (a `cloudflare:` import, a tsconfig
 * path alias `jiti` does not read) answers `unloadable` with the reason.
 */
const checkDevEnv = async (options: DevEnvCheckOptions): Promise<DevEnvCheck> => {
    const envPath = join(options.projectRoot, options.schemaDirectory, ENV_FILENAME);

    if (!existsSync(envPath)) {
        return { kind: "absent" };
    }

    let accessor: EnvAccessorLike | undefined;

    try {
        const namespace = await (options.load ?? defaultLoad)(envPath);

        accessor = Object.values((namespace ?? {}) as Record<string, unknown>).find((value) => isAccessor(value));
    } catch (error: unknown) {
        return { error: messageOf(error), kind: "unloadable" };
    }

    if (accessor === undefined) {
        return { kind: "absent" };
    }

    const { bindingNames, env, sources } = localWorkerEnv(options.projectRoot);

    try {
        accessor.parse(env);

        return { kind: "valid" };
    } catch (error: unknown) {
        const failures = failuresOf(error);

        if (failures === undefined) {
            return { error: messageOf(error), kind: "unloadable" };
        }

        // A key the worker gets as a binding is not a var, so its absence here is not news.
        const real = failures.filter((failure) => !bindingNames.has(failure.key));

        return real.length === 0 ? { kind: "valid" } : { failures: real, kind: "invalid", sources };
    }
};

/**
 * The one log line {@link checkDevEnv}'s result deserves, with its level — or
 * `undefined` when there is nothing to say.
 */
const describeDevEnvCheck = (check: DevEnvCheck, schemaDirectory: string): undefined | { level: "info" | "warn"; message: string } => {
    const file = `${schemaDirectory}/${ENV_FILENAME}`;

    if (check.kind === "unloadable") {
        return { level: "info", message: `${file} could not be loaded to check the dev env, so it is checked on first read instead: ${check.error}` };
    }

    if (check.kind !== "invalid") {
        return undefined;
    }

    const from = check.sources.length === 0 ? "no env files" : check.sources.join(" + ");
    const lines = check.failures.map((failure) => `  - ${failure.key}: ${failure.message}`);

    return {
        level: "warn",
        message: [
            `${file}: ${String(check.failures.length)} key(s) missing or invalid in the dev env (${from}) — the first request that reads one will fail:`,
            ...lines,
        ].join("\n"),
    };
};

export type { DevEnvCheck, DevEnvCheckOptions, DevEnvFailure };
export { checkDevEnv, describeDevEnvCheck };
