/**
 * The env a local dev worker boots with, assembled the way wrangler 4.156's
 * `getVarsForDev` does it — the function `wrangler dev` runs and
 * `@cloudflare/vite-plugin` calls through `unstable_getVarsForDev`. In order:
 *
 * First, the wrangler `vars` of the active environment. `vars` is not
 * inherited, so an `env.<name>` block contributes its own `vars` or none.
 *
 * Then `.dev.vars.<env>`, else `.dev.vars`. When neither exists, and
 * `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV` is not `false`, the `.env` files
 * instead (`.env`, `.env.local`, then `.env.<env>` and `.env.<env>.local`), later
 * files winning, expanded with `dotenv-expand`. The shell environment joins that
 * expansion, and the env, only when wrangler includes it: with
 * `CLOUDFLARE_INCLUDE_PROCESS_ENV` set to `true`, or a `secrets` block.
 *
 * Last, with a `secrets` block only the loaded keys that are a `var` or listed in
 * `secrets.required` are kept; without one, every loaded key.
 *
 * `.dev.vars` is never expanded and never merged with the shell environment,
 * exactly as wrangler leaves it.
 */
import { dirname } from "node:path";

import { expand } from "dotenv-expand";

import { readDevVariablesRecord, wranglerDotenvFiles } from "./dev-variables-format";
import join from "./path";

/** The slice of one wrangler environment (or the top level) the env is assembled from. */
interface WorkerEnvScope {
    secrets?: { required?: unknown } | null;
    vars?: Record<string, unknown> | null;
}

interface LocalWorkerEnvOptions {
    /** The parsed wrangler config, or `undefined` when the project has none. */
    config: (WorkerEnvScope & { env?: Record<string, WorkerEnvScope | null | undefined> | null }) | undefined;

    /** Where the wrangler config lives; wrangler reads `.dev.vars` and `.env` beside it. */
    configPath: string | undefined;

    /** The wrangler environment (`--env` / `CLOUDFLARE_ENV`), when one is active. */
    environment?: string;

    /** Defaults to `process.env`. */
    processEnv?: Record<string, string | undefined>;

    /** Where to look when there is no wrangler config. */
    projectRoot: string;

    /** `--var` values the worker is started with: applied last, over `.dev.vars` / `.env`, as wrangler applies its input bindings. */
    vars?: Readonly<Record<string, string>>;
}

interface LocalWorkerEnv {
    env: Record<string, unknown>;
    /** What contributed, in order (`wrangler vars`, `.dev.vars`, `.env`, `process.env`, …), for a log line. */
    sources: string[];
}

/** A wrangler boolean env flag; anything but `true`/`false` makes wrangler refuse to start, so it throws here too. */
const booleanFlag = (processEnv: Record<string, string | undefined>, name: string, fallback: boolean): boolean => {
    const value = processEnv[name];

    if (value === undefined) {
        return fallback;
    }

    switch (value.toLowerCase()) {
        case "false": {
            return false;
        }
        case "true": {
            return true;
        }
        default: {
            throw new Error(`Expected ${name} to be "true" or "false", but got ${JSON.stringify(value)}`);
        }
    }
};

/** The active scope: an `env.<name>` block when it exists, else the top level, as wrangler falls back. */
const activeScope = (config: LocalWorkerEnvOptions["config"], environment: string | undefined): WorkerEnvScope => {
    const block = environment === undefined ? undefined : config?.env?.[environment];

    return block ?? config ?? {};
};

/** `.dev.vars.<env>`, else `.dev.vars`, as `loadDotDevDotVars` picks it. */
const loadDevVariables = (directory: string, environment: string | undefined): { file: string; values: Record<string, string> } | undefined => {
    const files = environment === undefined ? [".dev.vars"] : [`.dev.vars.${environment}`, ".dev.vars"];

    for (const file of files) {
        const values = readDevVariablesRecord(join(directory, file));

        if (values !== undefined) {
            return { file, values };
        }
    }

    return undefined;
};

/** The `.env` files merged and expanded, as `loadDotEnv` does; an unreadable file is skipped, as wrangler only logs it. */
const loadDotenv = (
    directory: string,
    environment: string | undefined,
    includeProcessEnv: boolean,
    processEnv: Record<string, string | undefined>,
): { files: string[]; values: Record<string, string> } => {
    const parsed: Record<string, string> = {};
    const files: string[] = [];

    for (const file of wranglerDotenvFiles(environment)) {
        let values: Record<string, string> | undefined;

        try {
            values = readDevVariablesRecord(join(directory, file));
        } catch {
            continue;
        }

        if (values !== undefined) {
            Object.assign(parsed, values);
            files.push(file);
        }
    }

    const expanded: Record<string, string> = {};

    if (includeProcessEnv) {
        for (const [key, value] of Object.entries(processEnv)) {
            if (value !== undefined) {
                expanded[key] = value;
            }
        }
    }

    expand({ parsed, processEnv: expanded });

    return { files, values: expanded };
};

/** Assemble the local dev worker's env; see the module comment. Throws where wrangler would refuse to start. */
const resolveLocalWorkerEnv = (options: LocalWorkerEnvOptions): LocalWorkerEnv => {
    const processEnv = options.processEnv ?? process.env;
    const directory = options.configPath === undefined ? options.projectRoot : dirname(options.configPath);
    const scope = activeScope(options.config, options.environment);
    const env: Record<string, unknown> = { ...scope.vars };
    const sources = options.config === undefined ? [] : ["wrangler vars"];
    const secrets = scope.secrets ?? undefined;
    let loaded: Record<string, string> | undefined;

    const devVariables = loadDevVariables(directory, options.environment);

    if (devVariables !== undefined) {
        loaded = devVariables.values;
        sources.push(devVariables.file);
    } else if (booleanFlag(processEnv, "CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV", true)) {
        const includeProcessEnv = secrets !== undefined || booleanFlag(processEnv, "CLOUDFLARE_INCLUDE_PROCESS_ENV", false);
        const dotenv = loadDotenv(directory, options.environment, includeProcessEnv, processEnv);

        loaded = dotenv.values;
        sources.push(...dotenv.files, ...(includeProcessEnv ? ["process.env"] : []));
    }

    const required = new Set(Array.isArray(secrets?.required) ? secrets.required.filter((key): key is string => typeof key === "string") : []);

    for (const [key, value] of Object.entries(loaded ?? {})) {
        if (secrets === undefined || key in env || required.has(key)) {
            env[key] = value;
        }
    }

    // Wrangler 4.156's `getBindings` returns `{ ...fromConfigAndFiles, ...inputBindings }`:
    // a `--var` wins over the files, and does not count as declaring a key for the filter above.
    return { env: { ...env, ...options.vars }, sources };
};

export type { LocalWorkerEnv, LocalWorkerEnvOptions, WorkerEnvScope };
export { activeScope, resolveLocalWorkerEnv };
