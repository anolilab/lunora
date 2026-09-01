import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
    DEV_VARS_EXAMPLE_FILE,
    DEV_VARS_FILE,
    DEV_VARS_KEY_PATTERN,
    generateSecretValue,
    inferLunoraBindings,
    isMintableSecretKey,
    isPlaceholderValue,
    packageNamesFromBindings,
    parseDevVariableEntries,
    removeDevVariableLine,
    requiredSecrets,
    resolveDeployDriver,
    resolveProjectTarget,
    upsertDevVariableLine,
    writeDevVariablesFileAtomically,
} from "@lunora/config";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { detectPackageManager, execArgsFor } from "../../util/detect-package-manager";
import type { Logger } from "../../util/logger";
import type { SpawnDescriptor, Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import type { ListRemoteSecretsInputs, ListRemoteSecretsResult } from "../../util/wrangler-secrets";
import { listRemoteSecrets } from "../../util/wrangler-secrets";
import type { EnvOptions } from "./index";

type EnvSubcommand = "diff" | "doctor" | "generate" | "get" | "list" | "push" | "set" | "unset";

interface EnvCommandOptions {
    cwd?: string;

    /**
     * Cloudflare environment name for `push`/`diff` (`wrangler … --env <name>`).
     * `prod` is a boolean-only alias for `env: "production"` kept for backward
     * compatibility — when both are set, `env` wins.
     */
    env?: string;
    /** Required for `set`. Required (positional) for `get`/`unset`. */
    key?: string;
    logger: Logger;
    prod?: boolean;
    /** Remote-secret lister for `pull`/`diff`; injected in tests. */
    secretLister?: (inputs: ListRemoteSecretsInputs) => Promise<ListRemoteSecretsResult>;
    /** For `generate` — also write the generated secrets into `.dev.vars` (default: print to stdout). */
    set?: boolean;
    spawner?: Spawner;
    subcommand: EnvSubcommand;

    /**
     * Push secrets to a temporary-account deployment (`wrangler secret put
     * --temporary`). For unauthenticated use only — wrangler errors if
     * credentials are present.
     */
    temporary?: boolean;
    /** Required for `set`. */
    value?: string;
    /** When true, `push` proceeds without an explicit confirmation prompt. */
    yes?: boolean;
}

interface EnvCommandResult {
    code: number;
    /** For `push`, the descriptors that were spawned. */
    descriptors: ReadonlyArray<SpawnDescriptor>;
}

const NEWLINE_PRESENT = /[\r\n]/u;

/**
 * `.dev.vars` values are wrapped in double quotes on write. The shared read
 * path is dotenv, which strips those quotes and expands `\n`/`\r` inside them
 * but nothing else — so a `"` would end the value early and a `\` would either
 * survive verbatim or turn into a newline, and neither round-trips (each
 * rewrite compounds it). Reject both characters at write time instead, the
 * same way newlines are rejected.
 */
const UNREPRESENTABLE_PRESENT = /["\\]/u;

interface ParsedLine {
    key: string;
    value: string;
}

const parseDevVariables = (content: string): Map<string, ParsedLine> => new Map(parseDevVariableEntries(content).map((entry) => [entry.key, entry]));

/** Raw `.dev.vars` text, or `""` when the file does not exist yet. */
const readDevVariablesRaw = (devVariablesPath: string): string => (existsSync(devVariablesPath) ? readFileSync(devVariablesPath, "utf8") : "");

const redact = (value: string): string => {
    if (value.length <= 4) {
        return "****";
    }

    return `${value.slice(0, 4)}${"*".repeat(Math.min(8, value.length - 4))}`;
};

const loadDevVariables = (devVariablesPath: string): Map<string, ParsedLine> => parseDevVariables(readDevVariablesRaw(devVariablesPath));

interface EnvContext {
    cwd: string;
    devVariablesPath: string;
    logger: Logger;
    options: EnvCommandOptions;
}

/**
 * The Cloudflare environment `push`/`diff` should target: the explicit
 * `--env <name>` wins; `--prod` is kept as a boolean-only alias for
 * `--env production`; otherwise `undefined` (top-level config).
 */
const resolveEnvironment = (options: EnvCommandOptions): string | undefined => options.env ?? (options.prod === true ? "production" : undefined);

const runEnvList = (context: EnvContext): EnvCommandResult => {
    const map = loadDevVariables(context.devVariablesPath);

    if (map.size === 0) {
        context.logger.info(`${DEV_VARS_FILE}: (empty)`);

        return { code: 0, descriptors: [] };
    }

    for (const entry of map.values()) {
        context.logger.info(`${entry.key}=${redact(entry.value)}`);
    }

    return { code: 0, descriptors: [] };
};

const runEnvGet = (context: EnvContext): EnvCommandResult => {
    const { devVariablesPath, logger, options } = context;

    if (!options.key) {
        logger.error("env get requires a key. Usage: lunora env get <KEY>");

        return { code: 1, descriptors: [] };
    }

    const entry = loadDevVariables(devVariablesPath).get(options.key);

    if (!entry) {
        logger.error(`env: ${options.key} is not set in ${DEV_VARS_FILE}`);

        return { code: 1, descriptors: [] };
    }

    // Get prints the full value (caller asked for it explicitly).
    process.stdout.write(`${entry.value}\n`);

    return { code: 0, descriptors: [] };
};

const runEnvSet = (context: EnvContext): EnvCommandResult => {
    const { devVariablesPath, logger, options } = context;

    if (!options.key) {
        logger.error("env set requires a key. Usage: lunora env set <KEY> <VALUE>");

        return { code: 1, descriptors: [] };
    }

    if (!DEV_VARS_KEY_PATTERN.test(options.key)) {
        logger.error(`env: invalid key "${options.key}" — must match [A-Za-z_][A-Za-z0-9_]*`);

        return { code: 1, descriptors: [] };
    }

    if (options.value === undefined) {
        logger.error("env set requires a value. Usage: lunora env set <KEY> <VALUE>");

        return { code: 1, descriptors: [] };
    }

    // `.dev.vars` is a line-oriented format and parseDevVariables splits on
    // newlines; a value containing CR/LF would corrupt the round-trip and
    // could inject spurious vars. Reject rather than silently mangle.
    if (NEWLINE_PRESENT.test(options.value)) {
        logger.error(`env: value for "${options.key}" contains a newline, which .dev.vars cannot represent`);

        return { code: 1, descriptors: [] };
    }

    // A `"` or `\` would not round-trip: the shared grammar's read path strips
    // the outer quotes but never unescapes, so a stored `a\"b`/`a\\b` reads back
    // mangled and re-escapes (compounds) on every rewrite. Reject rather than
    // silently corrupt the value (and later push the wrong secret to prod).
    if (UNREPRESENTABLE_PRESENT.test(options.value)) {
        logger.error(`env: value for "${options.key}" contains a double-quote or backslash, which .dev.vars cannot round-trip`);

        return { code: 1, descriptors: [] };
    }

    const raw = readDevVariablesRaw(devVariablesPath);

    writeDevVariablesFileAtomically(devVariablesPath, upsertDevVariableLine(raw, options.key, options.value));
    logger.success(`env: set ${options.key} (${redact(options.value)}) in ${DEV_VARS_FILE}`);

    return { code: 0, descriptors: [] };
};

const runEnvUnset = (context: EnvContext): EnvCommandResult => {
    const { devVariablesPath, logger, options } = context;

    if (!options.key) {
        logger.error("env unset requires a key. Usage: lunora env unset <KEY>");

        return { code: 1, descriptors: [] };
    }

    if (!DEV_VARS_KEY_PATTERN.test(options.key)) {
        logger.error(`env: invalid key "${options.key}" — must match [A-Za-z_][A-Za-z0-9_]*`);

        return { code: 1, descriptors: [] };
    }

    const raw = readDevVariablesRaw(devVariablesPath);

    if (!parseDevVariables(raw).has(options.key)) {
        logger.warn(`env: ${options.key} was not set in ${DEV_VARS_FILE}`);

        return { code: 0, descriptors: [] };
    }

    writeDevVariablesFileAtomically(devVariablesPath, removeDevVariableLine(raw, options.key));
    logger.success(`env: unset ${options.key} in ${DEV_VARS_FILE}`);

    return { code: 0, descriptors: [] };
};

const runEnvPush = async (context: EnvContext): Promise<EnvCommandResult> => {
    const { devVariablesPath, logger, options } = context;

    if (!options.yes) {
        logger.error("env push uploads secrets to Cloudflare. Re-run with --yes to confirm.");

        return { code: 1, descriptors: [] };
    }

    const map = loadDevVariables(devVariablesPath);

    if (map.size === 0) {
        logger.warn(`${DEV_VARS_FILE}: nothing to push (empty)`);

        return { code: 0, descriptors: [] };
    }

    const placeholders = [...map.values()].filter((entry) => isPlaceholderValue(entry.value)).map((entry) => entry.key);

    if (placeholders.length > 0) {
        logger.error(
            `env push: refusing to upload placeholder value(s) for ${placeholders.join(", ")} — ` +
                `run \`lunora env doctor\` to review, and \`lunora env generate --set\` (or \`lunora env set <KEY> <VALUE>\`) to fill them, then re-run.`,
        );

        return { code: 1, descriptors: [] };
    }

    const spawner = options.spawner ?? defaultSpawner;
    const cwd = options.cwd ?? process.cwd();
    const manager = detectPackageManager(cwd);
    const descriptors: SpawnDescriptor[] = [];
    const environment = resolveEnvironment(options);

    for (const entry of map.values()) {
        // The toolchain is the target's, not always wrangler's — resolving from the
        // project keeps a non-default target from shelling out to the wrong CLI.
        const secretCommand = resolveDeployDriver(resolveProjectTarget(cwd)).toolchain?.secretPut({
            environment,
            key: entry.key,
            temporary: options.temporary,
        });

        if (secretCommand === undefined) {
            logger.error("deploy target has no command-line toolchain; cannot push secrets");

            return { code: 1, descriptors: [] };
        }

        const exec = execArgsFor(manager, secretCommand.tool, secretCommand.args);
        const descriptor: SpawnDescriptor = {
            args: exec.args,
            command: exec.command,
            cwd,
            // `wrangler secret put <name>` reads the value from stdin. We
            // pipe it through the spawner's `input` channel so the secret
            // never lands on the command line, in env, or in shell history.
            input: entry.value,
        };

        descriptors.push(descriptor);
        logger.info(`pushing ${entry.key} -> wrangler secret${environment === undefined ? "" : ` (${environment})`}`);

        // eslint-disable-next-line no-await-in-loop -- secrets push sequentially so a failure aborts.
        const result = await spawner(descriptor);

        if (result.code !== 0) {
            logger.error(`env push: failed at ${entry.key} (exit ${String(result.code)})`);

            return { code: result.code, descriptors };
        }
    }

    logger.success(`env: pushed ${String(map.size)} secret(s)`);

    return { code: 0, descriptors };
};

/** List the deployed Worker's secret names for `diff` (the resolved --env/--prod target). */
const fetchRemoteSecretNames = (context: EnvContext): Promise<ListRemoteSecretsResult> => {
    const lister = context.options.secretLister ?? listRemoteSecrets;

    return lister({
        cwd: context.cwd,
        env: resolveEnvironment(context.options),
        temporary: context.options.temporary,
    });
};

/**
 * Compare local `.dev.vars` keys against the deployed Worker's secret names:
 * keys only-local (need a `push`), only-remote (in Cloudflare but not local),
 * and in both. Informational — always exits 0.
 */
const runEnvDiff = async (context: EnvContext): Promise<EnvCommandResult> => {
    const { devVariablesPath, logger } = context;
    const remote = await fetchRemoteSecretNames(context);

    if (!remote.ok) {
        logger.error(`env diff: ${remote.error ?? "failed to list remote secrets"}`);

        return { code: 1, descriptors: [] };
    }

    const localKeys = new Set(loadDevVariables(devVariablesPath).keys());
    const remoteKeys = new Set(remote.names);
    const localOnly = [...localKeys].filter((key) => !remoteKeys.has(key)).toSorted((a, b) => a.localeCompare(b));
    const remoteOnly = remote.names.filter((name) => !localKeys.has(name));
    const both = [...localKeys].filter((key) => remoteKeys.has(key)).toSorted((a, b) => a.localeCompare(b));

    for (const key of localOnly) {
        logger.info(`local only (run \`lunora env push\`): ${key}`);
    }

    for (const key of remoteOnly) {
        logger.info(`remote only (in Cloudflare, not ${DEV_VARS_FILE}): ${key}`);
    }

    logger.info(`in both: ${String(both.length)} secret(s)`);

    if (localOnly.length === 0 && remoteOnly.length === 0) {
        logger.success("env diff: local and remote secret names match");
    }

    return { code: 0, descriptors: [] };
};

/**
 * Validate `.dev.vars` against `.dev.vars.example`: report keys the example lists
 * but the file lacks (error), keys whose values still look like placeholders
 * (error), and keys present locally but absent from the example (info). Exits
 * non-zero when anything is actionable, so it can gate CI / a pre-dev check.
 */
const runEnvDoctor = (context: EnvContext): EnvCommandResult => {
    const { cwd, devVariablesPath, logger } = context;
    const examplePath = join(cwd, DEV_VARS_EXAMPLE_FILE);

    if (!existsSync(examplePath)) {
        logger.info(`env doctor: no ${DEV_VARS_EXAMPLE_FILE} to check against — nothing to validate.`);

        return { code: 0, descriptors: [] };
    }

    const exampleKeys = parseDevVariableEntries(readFileSync(examplePath, "utf8")).map((entry) => entry.key);
    const current = loadDevVariables(devVariablesPath);

    if (!existsSync(devVariablesPath)) {
        logger.error(`env doctor: ${DEV_VARS_FILE} is missing. Run \`lunora dev\` to scaffold it, or \`lunora env set <KEY> <VALUE>\`.`);
        logger.info(`expected (from ${DEV_VARS_EXAMPLE_FILE}): ${exampleKeys.join(", ")}`);

        return { code: 1, descriptors: [] };
    }

    const missing = exampleKeys.filter((key) => !current.has(key));
    const placeholders = [...current.values()].filter((entry) => isPlaceholderValue(entry.value)).map((entry) => entry.key);
    const exampleKeySet = new Set(exampleKeys);
    const extra = [...current.keys()].filter((key) => !exampleKeySet.has(key));

    for (const key of missing) {
        logger.error(`missing: ${key} is in ${DEV_VARS_EXAMPLE_FILE} but not ${DEV_VARS_FILE}`);
    }

    for (const key of placeholders) {
        logger.error(`unset: ${key} still has a placeholder value`);
    }

    for (const key of extra) {
        logger.info(`extra: ${key} is set locally but not listed in ${DEV_VARS_EXAMPLE_FILE}`);
    }

    if (missing.length === 0 && placeholders.length === 0) {
        logger.success(`env doctor: ${DEV_VARS_FILE} looks good (${String(current.size)} var(s)).`);

        return { code: 0, descriptors: [] };
    }

    return { code: 1, descriptors: [] };
};

/**
 * Resolve the project's mintable secret keys (no explicit key given): the
 * locally-generatable secrets the project requires (core `LUNORA_ADMIN_TOKEN` +
 * the secret-typed vars of its installed `@lunora/*` packages), plus any
 * mintable secret already present in `.dev.vars` (covers feature-registry keys
 * like `STORAGE_SIGNING_SECRET`). Provider keys (`RESEND_API_KEY`, `STRIPE_*`)
 * are excluded — they can't be minted. Binding inference is best-effort.
 */
const resolveMintableKeys = async (context: EnvContext): Promise<string[]> => {
    let packages: ReadonlyArray<string> = [];

    try {
        packages = packageNamesFromBindings(await inferLunoraBindings({ projectRoot: context.cwd }));
    } catch {
        // Scan failure → fall back to the core secret + whatever is already local.
    }

    const fromPackages = requiredSecrets(packages)
        .map((entry) => entry.key)
        .filter((key) => isMintableSecretKey(key));
    const fromLocal = [...loadDevVariables(context.devVariablesPath).keys()].filter((key) => isMintableSecretKey(key));

    return [...new Set([...fromPackages, ...fromLocal])];
};

/**
 * Split a minted batch into the keys `--set` may write and the keys already
 * holding a live secret.
 *
 * A minted value REPLACES whatever is there, and the old one is gone — every
 * session, signed URL and admin bearer issued under it stops verifying. With no
 * explicit key `env generate` unions the required secrets with every mintable key
 * already in `.dev.vars`, which is how "fill in the placeholders `env doctor`
 * complained about" rotated live credentials nobody asked it to touch.
 */
const partitionMintable = (
    devVariablesPath: string,
    generated: ReadonlyArray<{ key: string; value: string }>,
    rotate: boolean,
): { live: string[]; writable: ReadonlyArray<{ key: string; value: string }> } => {
    const existing = loadDevVariables(devVariablesPath);
    const holdsLiveValue = (key: string): boolean => {
        const entry = existing.get(key);

        return entry !== undefined && entry.value !== "" && !isPlaceholderValue(entry.value);
    };

    return {
        live: generated.filter((entry) => holdsLiveValue(entry.key)).map((entry) => entry.key),
        writable: rotate ? generated : generated.filter((entry) => !holdsLiveValue(entry.key)),
    };
};

/** Upsert the minted secrets into `.dev.vars`, refusing to rotate live values without `--yes`. */
const writeGeneratedSecrets = (context: EnvContext, generated: ReadonlyArray<{ key: string; value: string }>): EnvCommandResult => {
    const { devVariablesPath, logger, options } = context;
    const { live, writable } = partitionMintable(devVariablesPath, generated, options.yes === true);

    if (writable.length === 0) {
        logger.error(
            `env generate --set: ${live.join(", ")} already hold(s) a live secret and rotating it is irreversible ` +
                `(outstanding signed URLs and bearers stop verifying). Re-run with --yes to rotate anyway.`,
        );

        return { code: 1, descriptors: [] };
    }

    if (live.length > 0) {
        logger.warn(`env generate --set: left ${live.join(", ")} untouched (already set) — re-run with --yes to rotate them too`);
    }

    let raw = readDevVariablesRaw(devVariablesPath);

    for (const entry of writable) {
        raw = upsertDevVariableLine(raw, entry.key, entry.value);
    }

    writeDevVariablesFileAtomically(devVariablesPath, raw);
    logger.success(`env: generated ${String(writable.length)} secret(s) into ${DEV_VARS_FILE}: ${writable.map((entry) => entry.key).join(", ")}`);

    return { code: 0, descriptors: [] };
};

/**
 * Generate cryptographically-strong secret values (32-byte hex) so the user can
 * set them for prod or other envs. With an explicit key argument it mints that
 * one key; with none it mints every secret the project can generate locally.
 * Prints `KEY=value` lines to stdout by default (pipe into `wrangler secret
 * put`), or with `--set` writes them into `.dev.vars`.
 */
const runEnvGenerate = async (context: EnvContext): Promise<EnvCommandResult> => {
    const { logger, options } = context;

    let keys: string[];

    if (options.key === undefined) {
        keys = await resolveMintableKeys(context);

        if (keys.length === 0) {
            logger.info("env generate: no locally-generatable secrets for this project. Name one explicitly: lunora env generate <KEY>");

            return { code: 0, descriptors: [] };
        }
    } else {
        // An explicit key is minted even if it's a provider key — the user named it.
        if (!DEV_VARS_KEY_PATTERN.test(options.key)) {
            logger.error(`env: invalid key "${options.key}" — must match [A-Za-z_][A-Za-z0-9_]*`);

            return { code: 1, descriptors: [] };
        }

        keys = [options.key];
    }

    const generated = keys.map((key) => {
        return { key, value: generateSecretValue() };
    });

    if (options.set === true) {
        return writeGeneratedSecrets(context, generated);
    }

    // Print full `KEY=value` lines to stdout (the user asked to generate them —
    // e.g. to pipe into `wrangler secret put`). Not via the logger, which redacts.
    for (const entry of generated) {
        process.stdout.write(`${entry.key}=${entry.value}\n`);
    }

    return { code: 0, descriptors: [] };
};

const runEnvCommand = async (options: EnvCommandOptions): Promise<EnvCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const context: EnvContext = {
        cwd,
        devVariablesPath: join(cwd, DEV_VARS_FILE),
        logger: options.logger,
        options,
    };

    switch (options.subcommand) {
        case "diff": {
            return runEnvDiff(context);
        }
        case "doctor": {
            return runEnvDoctor(context);
        }
        case "generate": {
            return runEnvGenerate(context);
        }
        case "get": {
            return runEnvGet(context);
        }
        case "list": {
            return runEnvList(context);
        }
        case "push": {
            return runEnvPush(context);
        }
        case "set": {
            return runEnvSet(context);
        }
        case "unset": {
            return runEnvUnset(context);
        }
        default: {
            options.logger.error(`env: unknown subcommand "${options.subcommand as string}"`);

            return { code: 1, descriptors: [] };
        }
    }
};

const ENV_SUBCOMMANDS: ReadonlySet<string> = new Set(["diff", "doctor", "generate", "get", "list", "push", "set", "unset"]);

/** Narrow a raw argument to a known {@link EnvSubcommand}. */
const isEnvSubcommand = (value: unknown): value is EnvSubcommand => typeof value === "string" && ENV_SUBCOMMANDS.has(value);

/** `lunora env <subcommand>` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<EnvOptions> = defineHandler<EnvOptions>(({ argument, cwd, logger, options }) => {
    const sub = argument[0];

    if (!isEnvSubcommand(sub)) {
        logger.error(`env: unknown subcommand "${sub ?? ""}" — expected list | get | set | unset | push | diff | doctor | generate`);

        return { code: 1 };
    }

    return runEnvCommand({
        cwd,
        env: options.env,
        key: argument[1],
        logger,
        prod: options.prod === true,
        set: options.set === true,
        subcommand: sub,
        temporary: options.temporary === true,
        value: argument[2],
        yes: options.yes === true,
    });
});

export { execute };
export type { EnvCommandOptions, EnvCommandResult, EnvSubcommand };
export { runEnvCommand };
