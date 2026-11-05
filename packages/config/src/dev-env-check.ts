/**
 * An eager check of the project's `defineEnv` contract (`lunora/env.ts`) against
 * the values a local dev worker boots with.
 *
 * `defineEnv` validates lazily, per key, on first read — the right model inside a
 * Worker, where an unused key must not fail a request that never touches it. It
 * also means a missing or malformed value surfaces as a 500 from whichever request
 * first reads it. Checking every key at dev start turns that into a startup
 * warning. A warning, never a failure: a half-filled `.dev.vars` is a normal state
 * while working on one part of an app.
 *
 * `env.ts` is imported with jiti, in Node, on every check — its own imports run
 * too. The env is assembled as wrangler assembles it (see `local-worker-env.ts`).
 */
import { existsSync } from "node:fs";

import { ENV_FILENAME } from "@lunora/codegen";

import type { EnvKeyFailure } from "../../../shared/env-contract";
import { envContractOf } from "../../../shared/env-contract";
import { REDACTED, redactSecrets } from "../../../shared/redact-secrets";
import type { ManifestConfigShape } from "./cloudflare/binding-manifest";
import { buildBindingManifest } from "./cloudflare/binding-manifest";
import { readProjectWrangler, readWranglerJsonc } from "./cloudflare/wrangler-path";
import type { LocalWorkerEnvOptions } from "./local-worker-env";
import { activeScope, resolveLocalWorkerEnv } from "./local-worker-env";
import join from "./path";

/** What {@link checkDevEnv} found. */
type DevEnvCheck =
    | { error: string; kind: "unloadable" }
    | { failures: EnvKeyFailure[]; kind: "invalid"; sources: string[] }
    | { kind: "absent" }
    | { kind: "valid" };

interface DevEnvCheckOptions {
    /**
     * The wrangler config the dev worker runs, when it is not the project's
     * `wrangler.jsonc` — the SvelteKit / Nuxt sidecar runs `wrangler.dev.jsonc`.
     * Its vars, its bindings, and the `.dev.vars` / `.env` beside it are read.
     */
    configPath?: string;

    /** The wrangler environment the dev worker runs; defaults to `CLOUDFLARE_ENV`, which wrangler reads too. */
    environment?: string;

    /**
     * Imports `lunora/env.ts` and answers its module namespace. Defaults to a
     * cache-free `jiti` import, so an edited contract is read fresh.
     */
    load?: (path: string) => Promise<unknown>;

    /** Defaults to `process.env`. */
    processEnv?: Record<string, string | undefined>;

    projectRoot: string;
    schemaDirectory: string;

    /** `--var` values the dev worker is started with. A key the config or env files set keeps their value, as wrangler keeps it. */
    vars?: Readonly<Record<string, string>>;

    /** Binding names the dev session leaves out of the worker (a logged-out `ai` / `artifacts`), so they are not exempt. */
    withheld?: ReadonlyArray<string>;
}

type WranglerConfig = LocalWorkerEnvOptions["config"] & ManifestConfigShape;

/** The given config, or the project's — `undefined` when there is none, `parsed: undefined` when it cannot be read. */
const readDevWrangler = (options: DevEnvCheckOptions): { parsed: WranglerConfig | undefined; path: string } | undefined => {
    if (options.configPath === undefined) {
        return readProjectWrangler<WranglerConfig>(options.projectRoot);
    }

    if (!existsSync(options.configPath)) {
        return undefined;
    }

    try {
        return { parsed: readWranglerJsonc<WranglerConfig>(options.configPath).parsed, path: options.configPath };
    } catch {
        return { parsed: undefined, path: options.configPath };
    }
};

const defaultLoad = async (path: string): Promise<unknown> => {
    const { createJiti } = await import("jiti");

    return createJiti(path, { interopDefault: false, moduleCache: false }).import(path);
};

/** Below this length a value is too likely to occur by chance in the message's own words to be masked by text. */
const MIN_MASKED_LENGTH = 3;

/**
 * The parts of `value` a validator message could quote: the value itself and,
 * for a URL, its password. `redactSecrets` keys off secret-looking names and
 * shapes, so a short password in a `DATABASE_URL` slips past it.
 */
const quotablePartsOf = (value: unknown): string[] => {
    if (typeof value !== "string") {
        return [];
    }

    const parts = [value];

    if (URL.canParse(value)) {
        const { password } = new URL(value);

        parts.push(password);

        try {
            parts.push(decodeURIComponent(password));
        } catch {
            // A stray `%` the URL parser kept as is: the encoded form above is all there is.
        }
    }

    return parts.filter((part) => part.length >= MIN_MASKED_LENGTH).toSorted((a, b) => b.length - a.length);
};

/** A failure's message with the key's own value masked, whatever the key is named. */
const maskOwnValue = (failure: EnvKeyFailure, env: Record<string, unknown>): EnvKeyFailure => {
    let { message } = failure;

    for (const part of quotablePartsOf(env[failure.key])) {
        message = message.replaceAll(part, REDACTED);
    }

    return { ...failure, message };
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const runCheck = async (options: DevEnvCheckOptions): Promise<DevEnvCheck> => {
    const envPath = join(options.projectRoot, options.schemaDirectory, ENV_FILENAME);

    if (!existsSync(envPath)) {
        return { kind: "absent" };
    }

    const namespace = await (options.load ?? defaultLoad)(envPath);
    const check = Object.values((namespace ?? {}) as Record<string, unknown>)
        .map((value) => envContractOf(value))
        .find((contract) => contract !== undefined);

    if (check === undefined) {
        return { kind: "absent" };
    }

    const processEnv = options.processEnv ?? process.env;
    const fromProcess = processEnv["CLOUDFLARE_ENV"];
    const environment = options.environment ?? (fromProcess === "" ? undefined : fromProcess);
    const wrangler = readDevWrangler(options);

    if (wrangler !== undefined && wrangler.parsed === undefined) {
        return { error: `${wrangler.path} could not be read as JSONC`, kind: "unloadable" };
    }

    const resolved = resolveLocalWorkerEnv({
        config: wrangler?.parsed,
        configPath: wrangler?.path,
        environment,
        processEnv,
        projectRoot: options.projectRoot,
    });
    const env = { ...options.vars, ...resolved.env };
    const scope = activeScope(wrangler?.parsed, environment) as ManifestConfigShape;
    const withheld = new Set(options.withheld);
    // A key the worker gets as a binding is not a var, so its absence here is not
    // news — unless this session withholds that binding from the worker.
    const bindingNames = new Set(
        wrangler === undefined
            ? []
            : buildBindingManifest(scope)
                  .bindings.map((requirement) => requirement.binding)
                  .filter((binding) => !withheld.has(binding)),
    );
    const failures = check(env)
        .filter((failure) => !bindingNames.has(failure.key))
        .map((failure) => maskOwnValue(failure, env));

    return failures.length === 0 ? { kind: "valid" } : { failures, kind: "invalid", sources: resolved.sources };
};

/**
 * Run the project's env contract against its local worker env. Never throws:
 * anything that stops the check — a contract that cannot be loaded on the host
 * (a `cloudflare:` import, a tsconfig path alias jiti does not read), an
 * unreadable `.dev.vars`, a wrangler config whose bindings cannot be read —
 * answers `unloadable` with the reason, secrets redacted.
 */
const checkDevEnv = async (options: DevEnvCheckOptions): Promise<DevEnvCheck> => {
    try {
        return await runCheck(options);
    } catch (error: unknown) {
        return { error: redactSecrets(messageOf(error)), kind: "unloadable" };
    }
};

/**
 * The one log line {@link checkDevEnv}'s result deserves, with its level — or
 * `undefined` when there is nothing to say. `wasInvalid` is what the previous
 * check of the same server found, so a check that passes again says so.
 */
const describeDevEnvCheck = (
    check: DevEnvCheck,
    schemaDirectory: string,
    { wasInvalid = false }: { wasInvalid?: boolean } = {},
): undefined | { level: "info" | "warn"; message: string } => {
    const file = `${schemaDirectory}/${ENV_FILENAME}`;

    if (check.kind === "unloadable") {
        return { level: "info", message: `${file}: the dev env could not be checked, so a missing key surfaces on first read instead: ${check.error}` };
    }

    if (check.kind === "valid" && wasInvalid) {
        return { level: "info", message: `${file}: the dev env satisfies the contract again` };
    }

    if (check.kind === "absent" && wasInvalid) {
        return { level: "info", message: `${file}: no env contract is loaded any more, so the warning above no longer applies` };
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

export type { EnvKeyFailure } from "../../../shared/env-contract";
export { ENV_FILENAME } from "@lunora/codegen";
export type { DevEnvCheck, DevEnvCheckOptions };
export { checkDevEnv, describeDevEnvCheck };
