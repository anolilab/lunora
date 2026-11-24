import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
    DEV_VARS_EXAMPLE_FILE,
    DEV_VARS_FILE,
    DEV_VARS_KEY_PATTERN,
    generateSecretValue,
    inferLunoraBindings,
    isPlaceholderValue,
    mintableSecretKeysFor,
    parseDevVariableEntries,
    removeDevVariableLine,
    requiredSecrets,
    resolveDeployDriver,
    resolveProjectTarget,
    resolveSchemaDirectory,
    secretSourcesFromBindings,
    upsertDevVariableLine,
    writeDevVariablesFileAtomically,
} from "@lunora/config";

import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { detectPackageManager, toolchainExecArgs } from "../../util/detect-package-manager";
import { devVariablesFileFor, linkedDevVariablesFile, refuseUnsafeSecretFile, unconfirmedMintKeys } from "../../util/dev-variables-file";
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { OutputFormat } from "../../util/output-format";
import type { SpawnDescriptor, Spawner } from "../../util/spawn";
import { defaultSpawner } from "../../util/spawn";
import type { ListRemoteSecretsInputs, ListRemoteSecretsResult } from "../../util/wrangler-secrets";
import { listRemoteSecrets } from "../../util/wrangler-secrets";
import type { EnvOptions } from "./index";

type EnvSubcommand = "diff" | "doctor" | "generate" | "get" | "list" | "push" | "set" | "unset";

interface EnvCommandOptions {
    cwd?: string;

    /**
     * Named Cloudflare environment (`wrangler … --env <name>`). Every subcommand
     * then reads and writes `.dev.vars.<name>` instead of the bare `.dev.vars`.
     * `prod` is a boolean-only alias for `env: "production"` — when both are
     * set, `env` wins.
     */
    env?: string;
    /** Output format: `pretty` (default) or `json`. */
    format?: OutputFormat;
    /** For `push`/`diff` with a named environment: use the bare `.dev.vars` instead of `.dev.vars.<name>`. */
    fromDevVars?: boolean;
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

/**
 * The structured result one `env` subcommand produced, for `--format json`.
 *
 * Deliberately per-subcommand rather than one flat union of every field: the
 * eight verbs answer eight different questions, and a document carrying all of
 * them with most absent would tell a consumer nothing about which one it is
 * holding. `subcommand` is the discriminant.
 *
 * Keys are names throughout, never values — the exceptions are `get`, which the
 * caller asked for by name, and `generate` WITHOUT `--set`, whose whole product
 * is the minted values (the pretty path prints the same `KEY=value` pairs to
 * stdout, so the document discloses nothing the command did not already exist to
 * disclose).
 *
 * `generate --set` is deliberately a SEPARATE shape carrying only `written`.
 * There the values' destination is `.dev.vars`, and the caller never asked to
 * see them — the pretty path names the keys and prints no value. Serializing
 * them anyway made `--format json` strictly more disclosing than the default for
 * the same flags, putting freshly-minted admin bearers and signing secrets into
 * CI logs, shell history and whatever consumed the pipe. Two members rather than
 * an optional `value` so the `--set` document cannot carry one by construction.
 */
type EnvCommandData =
    | { both: string[]; localOnly: string[]; remoteOnly: string[]; subcommand: "diff" }
    | { extra: string[]; missing: string[]; ok: boolean; placeholders: string[]; subcommand: "doctor" }
    | { file: string; keys: string[]; subcommand: "list" }
    | { key: string; removed: boolean; subcommand: "unset" }
    | { key: string; subcommand: "set" }
    | { key: string; subcommand: "get"; value: string }
    | { pushed: string[]; subcommand: "push"; target?: string }
    | { secrets: { key: string; value: string }[]; subcommand: "generate" }
    | { subcommand: "generate"; written: string[] };

interface EnvCommandResult {
    code: number;
    /** The structured result `--format json` serializes. Absent when the run failed before producing one. */
    data?: EnvCommandData;
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
    /** The file this run reads and writes, relative to `cwd` — for messages. */
    devVariablesFile: string;
    devVariablesPath: string;
    /** The resolved `--env`/`--prod` target; `undefined` is the default environment. */
    environment: string | undefined;
    logger: Logger;
    options: EnvCommandOptions;
}

/**
 * The Cloudflare environment the run targets: the explicit
 * `--env <name>` wins; `--prod` is kept as a boolean-only alias for
 * `--env production`; otherwise `undefined` (top-level config).
 */
const resolveEnvironment = (options: EnvCommandOptions): string | undefined => options.env ?? (options.prod === true ? "production" : undefined);

/** A named environment's file holds deployed secrets: refuse the write unless {@link refuseUnsafeSecretFile} clears it. */
const ignoreNamedEnvironmentFile = (context: EnvContext): EnvCommandResult | undefined => {
    if (context.devVariablesFile === DEV_VARS_FILE) {
        return undefined;
    }

    const refusal = refuseUnsafeSecretFile(context.cwd, context.devVariablesFile, context.logger);

    if (refusal === undefined) {
        return undefined;
    }

    context.logger.error(`env: ${refusal}, then re-run.`);

    return { code: EXIT_CODE.USAGE, descriptors: [] };
};

const runEnvList = (context: EnvContext): EnvCommandResult => {
    const map = loadDevVariables(context.devVariablesPath);
    // Names only, matching the redaction the pretty rendering applies: `list`
    // enumerates what is set, `get <KEY>` is how a value is asked for.
    const data: EnvCommandData = { file: context.devVariablesFile, keys: [...map.keys()], subcommand: "list" };

    if (map.size === 0) {
        context.logger.info(`${context.devVariablesFile}: (empty)`);

        return { code: 0, data, descriptors: [] };
    }

    for (const entry of map.values()) {
        context.logger.info(`${entry.key}=${redact(entry.value)}`);
    }

    return { code: 0, data, descriptors: [] };
};

const runEnvGet = (context: EnvContext): EnvCommandResult => {
    const { devVariablesFile, devVariablesPath, logger, options } = context;

    if (!options.key) {
        logger.error("env get requires a key. Usage: lunora env get <KEY>");

        return { code: EXIT_CODE.USAGE, descriptors: [] };
    }

    const entry = loadDevVariables(devVariablesPath).get(options.key);

    if (!entry) {
        logger.error(`env: ${options.key} is not set in ${devVariablesFile}`);

        return { code: EXIT_CODE.NOT_FOUND, descriptors: [] };
    }

    // Get prints the full value (caller asked for it explicitly) — except in
    // json mode, where it rides the document instead so stdout stays one blob.
    if (options.format !== "json") {
        process.stdout.write(`${entry.value}\n`);
    }

    return { code: 0, data: { key: options.key, subcommand: "get", value: entry.value }, descriptors: [] };
};

const runEnvSet = (context: EnvContext): EnvCommandResult => {
    const { devVariablesFile, devVariablesPath, logger, options } = context;

    if (!options.key) {
        logger.error("env set requires a key. Usage: lunora env set <KEY> <VALUE>");

        return { code: EXIT_CODE.USAGE, descriptors: [] };
    }

    if (!DEV_VARS_KEY_PATTERN.test(options.key)) {
        logger.error(`env: invalid key "${options.key}" — must match [A-Za-z_][A-Za-z0-9_]*`);

        return { code: EXIT_CODE.USAGE, descriptors: [] };
    }

    if (options.value === undefined) {
        logger.error("env set requires a value. Usage: lunora env set <KEY> <VALUE>");

        return { code: EXIT_CODE.USAGE, descriptors: [] };
    }

    // `.dev.vars` is a line-oriented format and parseDevVariables splits on
    // newlines; a value containing CR/LF would corrupt the round-trip and
    // could inject spurious vars. Reject rather than silently mangle.
    if (NEWLINE_PRESENT.test(options.value)) {
        logger.error(`env: value for "${options.key}" contains a newline, which .dev.vars cannot represent`);

        return { code: EXIT_CODE.USAGE, descriptors: [] };
    }

    // A `"` or `\` would not round-trip: the shared grammar's read path strips
    // the outer quotes but never unescapes, so a stored `a\"b`/`a\\b` reads back
    // mangled and re-escapes (compounds) on every rewrite. Reject rather than
    // silently corrupt the value (and later push the wrong secret to prod).
    if (UNREPRESENTABLE_PRESENT.test(options.value)) {
        logger.error(`env: value for "${options.key}" contains a double-quote or backslash, which .dev.vars cannot round-trip`);

        return { code: EXIT_CODE.USAGE, descriptors: [] };
    }

    const refused = ignoreNamedEnvironmentFile(context);

    if (refused !== undefined) {
        return refused;
    }

    const raw = readDevVariablesRaw(devVariablesPath);

    writeDevVariablesFileAtomically(devVariablesPath, upsertDevVariableLine(raw, options.key, options.value));
    logger.success(`env: set ${options.key} (${redact(options.value)}) in ${devVariablesFile}`);

    return { code: 0, data: { key: options.key, subcommand: "set" }, descriptors: [] };
};

const runEnvUnset = (context: EnvContext): EnvCommandResult => {
    const { devVariablesFile, devVariablesPath, logger, options } = context;

    if (!options.key) {
        logger.error("env unset requires a key. Usage: lunora env unset <KEY>");

        return { code: EXIT_CODE.USAGE, descriptors: [] };
    }

    if (!DEV_VARS_KEY_PATTERN.test(options.key)) {
        logger.error(`env: invalid key "${options.key}" — must match [A-Za-z_][A-Za-z0-9_]*`);

        return { code: EXIT_CODE.USAGE, descriptors: [] };
    }

    // The rewrite replaces a link with a regular file holding the linked file's values, which a later push would upload.
    const refused = ignoreNamedEnvironmentFile(context);

    if (refused !== undefined) {
        return refused;
    }

    const raw = readDevVariablesRaw(devVariablesPath);

    if (!parseDevVariables(raw).has(options.key)) {
        logger.warn(`env: ${options.key} was not set in ${devVariablesFile}`);

        return { code: 0, data: { key: options.key, removed: false, subcommand: "unset" }, descriptors: [] };
    }

    writeDevVariablesFileAtomically(devVariablesPath, removeDevVariableLine(raw, options.key));
    logger.success(`env: unset ${options.key} in ${devVariablesFile}`);

    return { code: 0, data: { key: options.key, removed: true, subcommand: "unset" }, descriptors: [] };
};

const resolveSecretSources = async (cwd: string): Promise<ReadonlyArray<string>> => {
    try {
        return secretSourcesFromBindings(await inferLunoraBindings({ projectRoot: cwd, schemaDir: resolveSchemaDirectory(cwd) }));
    } catch {
        // Scan failure → fall back to the core secrets alone.
        return [];
    }
};

/** The keys deploy mints rather than ever taking from a local file — the same set `deploy`'s secrets gate uses. */
const resolveMintableKeySet = async (context: EnvContext): Promise<ReadonlySet<string>> => mintableSecretKeysFor(await resolveSecretSources(context.cwd));

/**
 * The refusal for a push whose source file is absent, or `undefined` to go on. The bare file is
 * local dev's: pushing it to a named environment would overwrite the secrets deploy minted there
 * (recorded in `.dev.vars.<name>`) with the developer's local values. A source named explicitly
 * with --from-dev-vars that is not there is a failure too, not an empty push to report as done.
 */
const refuseMissingPushSource = (context: EnvContext): EnvCommandResult | undefined => {
    const { devVariablesFile, devVariablesPath, environment, logger, options } = context;

    if (environment === undefined || existsSync(devVariablesPath)) {
        return undefined;
    }

    if (options.fromDevVars === true) {
        logger.error(`env push --env ${environment} --from-dev-vars: ${devVariablesFile} does not exist, so there is nothing to push.`);

        return { code: EXIT_CODE.NOT_FOUND, descriptors: [] };
    }

    logger.error(
        `env push --env ${environment}: ${devVariablesFile} does not exist. A named environment is pushed from its own file, never from ${DEV_VARS_FILE}, ` +
            `so local dev values cannot overwrite its secrets. Create it with \`lunora env set --env ${environment} <KEY> <VALUE>\` ` +
            `(or \`lunora env generate --set --env ${environment}\`), or pass --from-dev-vars to push ${DEV_VARS_FILE} to it.`,
    );

    return { code: EXIT_CODE.NOT_FOUND, descriptors: [] };
};

/**
 * The refusal for a named push whose own file is another `.dev.vars` file under another name — a
 * symlink or hard link to it — or `undefined` to go on. Following it would upload that file's values,
 * local dev credentials included, without --from-dev-vars and its mintable-key check.
 */
const refuseAliasedPushSource = (context: EnvContext): EnvCommandResult | undefined => {
    const { cwd, devVariablesFile, environment, logger, options } = context;

    if (environment === undefined || options.fromDevVars === true) {
        return undefined;
    }

    const linked = linkedDevVariablesFile(cwd, devVariablesFile);

    if (linked === undefined) {
        return undefined;
    }

    logger.error(
        `env push --env ${environment}: ${devVariablesFile} is a link to ${linked}, so it would push the values of ${linked}. ` +
            `Give ${devVariablesFile} its own values, or pass --from-dev-vars to push ${DEV_VARS_FILE} on purpose.`,
    );

    return { code: EXIT_CODE.USAGE, descriptors: [] };
};

/**
 * The refusal for a push whose file still holds a value minted by a deploy whose push failed, or
 * `undefined` to go on. Either that value or the active one may be live, and pushing the active one
 * could overwrite the other.
 */
const refuseUnconfirmedMints = (context: EnvContext): EnvCommandResult | undefined => {
    const unconfirmed = unconfirmedMintKeys(readDevVariablesRaw(context.devVariablesPath));

    if (unconfirmed.length === 0) {
        return undefined;
    }

    context.logger.error(
        `env push: ${unconfirmed.join(", ")} in ${context.devVariablesFile} also has a value minted by a deploy whose push failed (the "# Minted by a deploy…" comment), ` +
            `so it is unknown which one is live. Keep exactly one of the two values — delete the other line and the comment — then re-run.`,
    );

    return { code: EXIT_CODE.USAGE, descriptors: [] };
};

const runEnvPush = async (context: EnvContext): Promise<EnvCommandResult> => {
    const { devVariablesFile, devVariablesPath, environment, logger, options } = context;

    if (!options.yes) {
        logger.error("env push uploads secrets to Cloudflare. Re-run with --yes to confirm.");

        return { code: EXIT_CODE.USAGE, descriptors: [] };
    }

    const missingSource = refuseMissingPushSource(context) ?? refuseAliasedPushSource(context) ?? refuseUnconfirmedMints(context);

    if (missingSource !== undefined) {
        return missingSource;
    }

    const map = loadDevVariables(devVariablesPath);

    if (map.size === 0) {
        logger.warn(`${devVariablesFile}: nothing to push (empty)`);

        return { code: 0, data: { pushed: [], subcommand: "push", target: environment }, descriptors: [] };
    }

    const placeholders = [...map.values()].filter((entry) => isPlaceholderValue(entry.value)).map((entry) => entry.key);
    // The fix-up commands must edit the file just read: `.dev.vars.<name>` for a named
    // environment, but the bare `.dev.vars` under --from-dev-vars, which `--env` would miss.
    const environmentFlag = environment === undefined || options.fromDevVars === true ? "" : ` --env ${environment}`;
    const rerun = options.fromDevVars === true ? `re-run \`lunora env push --yes --env ${String(environment)} --from-dev-vars\`` : "re-run";

    if (placeholders.length > 0) {
        logger.error(
            `env push: refusing to upload placeholder value(s) for ${placeholders.join(", ")} in ${devVariablesFile} — ` +
                `run \`lunora env doctor${environmentFlag}\` to review, and \`lunora env generate --set${environmentFlag}\` (or \`lunora env set${environmentFlag} <KEY> <VALUE>\`) ` +
                `to fill them, then ${rerun}.`,
        );

        return { code: EXIT_CODE.USAGE, descriptors: [] };
    }

    if (options.fromDevVars === true) {
        // Deploy never promotes a local value for a key it can mint: a shared dev
        // secret would become the one protecting the named environment.
        const mintable = await resolveMintableKeySet(context);
        const refused = [...map.keys()].filter((key) => mintable.has(key));

        if (refused.length > 0) {
            logger.error(
                `env push --from-dev-vars: refusing to push the local ${refused.join(", ")} to --env ${String(environment)} — ` +
                    `a generated secret must not reuse the dev value. Remove it from ${DEV_VARS_FILE}, or set it in ${String(devVariablesFileFor(environment))} ` +
                    `with \`lunora env generate --set --env ${String(environment)}\` and push that file instead.`,
            );

            return { code: EXIT_CODE.USAGE, descriptors: [] };
        }
    }

    const spawner = options.spawner ?? defaultSpawner;
    const cwd = options.cwd ?? process.cwd();
    const manager = detectPackageManager(cwd);
    const descriptors: SpawnDescriptor[] = [];
    // The toolchain is the target's, not always wrangler's — resolving from the
    // project keeps a non-default target from shelling out to the wrong CLI.
    const driver = resolveDeployDriver(resolveProjectTarget(cwd));
    const secretPut = driver.toolchain?.secretPut;

    if (secretPut === undefined) {
        logger.error(`deploy target "${driver.id}" has no secret store; cannot push secrets`);

        return { code: EXIT_CODE.USAGE, descriptors: [] };
    }

    for (const entry of map.values()) {
        const secretCommand = secretPut({ environment, key: entry.key, temporary: options.temporary });
        const exec = toolchainExecArgs(manager, secretCommand);
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

    return { code: 0, data: { pushed: [...map.keys()], subcommand: "push", target: environment }, descriptors };
};

/** List the deployed Worker's secret names for `diff` (the resolved --env/--prod target). */
const fetchRemoteSecretNames = (context: EnvContext): Promise<ListRemoteSecretsResult> => {
    const lister = context.options.secretLister ?? listRemoteSecrets;

    return lister({
        cwd: context.cwd,
        env: context.environment,
        temporary: context.options.temporary,
    });
};

/**
 * Compare local `.dev.vars` keys against the deployed Worker's secret names:
 * keys only-local (need a `push`), only-remote (in Cloudflare but not local),
 * and in both. Informational — always exits 0.
 */
const runEnvDiff = async (context: EnvContext): Promise<EnvCommandResult> => {
    const { devVariablesFile, devVariablesPath, logger } = context;
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

    const environmentFlag = context.environment === undefined ? "" : ` --env ${context.environment}`;
    // `push --from-dev-vars` refuses a key deploy generates, so the dev value is never the hint for one.
    const generated = context.options.fromDevVars === true ? await resolveMintableKeySet(context) : new Set<string>();

    const pushHint = `lunora env push --yes${environmentFlag}${context.options.fromDevVars === true ? " --from-dev-vars" : ""}`;

    for (const key of localOnly) {
        logger.info(
            generated.has(key)
                ? `local only (generated per environment, never pushed from ${DEV_VARS_FILE}: run \`lunora deploy${environmentFlag}\` to mint it): ${key}`
                : `local only (run \`${pushHint}\`): ${key}`,
        );
    }

    for (const key of remoteOnly) {
        logger.info(`remote only (in Cloudflare, not ${devVariablesFile}): ${key}`);
    }

    logger.info(`in both: ${String(both.length)} secret(s)`);

    if (localOnly.length === 0 && remoteOnly.length === 0) {
        logger.success("env diff: local and remote secret names match");
    }

    return { code: 0, data: { both, localOnly, remoteOnly, subcommand: "diff" }, descriptors: [] };
};

/**
 * Validate `.dev.vars` against `.dev.vars.example`: report keys the example lists
 * but the file lacks (error), keys whose values still look like placeholders
 * (error), and keys present locally but absent from the example (info). Exits
 * non-zero when anything is actionable, so it can gate CI / a pre-dev check.
 */
const runEnvDoctor = (context: EnvContext): EnvCommandResult => {
    const { cwd, devVariablesFile, devVariablesPath, environment, logger } = context;
    const examplePath = join(cwd, DEV_VARS_EXAMPLE_FILE);

    if (!existsSync(examplePath)) {
        logger.info(`env doctor: no ${DEV_VARS_EXAMPLE_FILE} to check against — nothing to validate.`);

        return { code: 0, data: { extra: [], missing: [], ok: true, placeholders: [], subcommand: "doctor" }, descriptors: [] };
    }

    const exampleKeys = parseDevVariableEntries(readFileSync(examplePath, "utf8")).map((entry) => entry.key);
    const current = loadDevVariables(devVariablesPath);

    if (!existsSync(devVariablesPath)) {
        logger.error(
            environment === undefined
                ? `env doctor: ${DEV_VARS_FILE} is missing. Run \`lunora dev\` to scaffold it, or \`lunora env set <KEY> <VALUE>\`.`
                : `env doctor: ${devVariablesFile} is missing. Create it with \`lunora env set --env ${environment} <KEY> <VALUE>\`.`,
        );
        logger.info(`expected (from ${DEV_VARS_EXAMPLE_FILE}): ${exampleKeys.join(", ")}`);

        return { code: EXIT_CODE.NOT_FOUND, descriptors: [] };
    }

    const missing = exampleKeys.filter((key) => !current.has(key));
    const placeholders = [...current.values()].filter((entry) => isPlaceholderValue(entry.value)).map((entry) => entry.key);
    const exampleKeySet = new Set(exampleKeys);
    const extra = [...current.keys()].filter((key) => !exampleKeySet.has(key));

    for (const key of missing) {
        logger.error(`missing: ${key} is in ${DEV_VARS_EXAMPLE_FILE} but not ${devVariablesFile}`);
    }

    for (const key of placeholders) {
        logger.error(`unset: ${key} still has a placeholder value`);
    }

    for (const key of extra) {
        logger.info(`extra: ${key} is set locally but not listed in ${DEV_VARS_EXAMPLE_FILE}`);
    }

    const ok = missing.length === 0 && placeholders.length === 0;
    const data: EnvCommandData = { extra, missing, ok, placeholders, subcommand: "doctor" };

    if (ok) {
        logger.success(`env doctor: ${devVariablesFile} looks good (${String(current.size)} var(s)).`);

        return { code: 0, data, descriptors: [] };
    }

    return { code: 1, data, descriptors: [] };
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
    const packages = await resolveSecretSources(context.cwd);
    const mintable = mintableSecretKeysFor(packages);
    const fromPackages = requiredSecrets(packages)
        .map((entry) => entry.key)
        .filter((key) => mintable.has(key));
    // The same files deploy reads its required keys from: a named environment requires the bare file's keys too.
    const localFiles = context.devVariablesFile === DEV_VARS_FILE ? [context.devVariablesPath] : [join(context.cwd, DEV_VARS_FILE), context.devVariablesPath];
    const fromLocal = localFiles.flatMap((path) => [...loadDevVariables(path).keys()]).filter((key) => mintable.has(key));

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

        return { code: EXIT_CODE.USAGE, descriptors: [] };
    }

    if (live.length > 0) {
        logger.warn(`env generate --set: left ${live.join(", ")} untouched (already set) — re-run with --yes to rotate them too`);
    }

    let raw = readDevVariablesRaw(devVariablesPath);

    for (const entry of writable) {
        raw = upsertDevVariableLine(raw, entry.key, entry.value);
    }

    writeDevVariablesFileAtomically(devVariablesPath, raw);
    logger.success(`env: generated ${String(writable.length)} secret(s) into ${context.devVariablesFile}: ${writable.map((entry) => entry.key).join(", ")}`);

    // Key names only. The values went into `.dev.vars`; echoing them back on
    // stdout would hand a fresh admin bearer to every CI log and pipe consumer,
    // which the pretty path of this same flag combination does not do.
    return { code: 0, data: { subcommand: "generate", written: writable.map((entry) => entry.key) }, descriptors: [] };
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

            return { code: 0, data: { secrets: [], subcommand: "generate" }, descriptors: [] };
        }
    } else {
        // An explicit key is minted even if it's a provider key — the user named it.
        if (!DEV_VARS_KEY_PATTERN.test(options.key)) {
            logger.error(`env: invalid key "${options.key}" — must match [A-Za-z_][A-Za-z0-9_]*`);

            return { code: EXIT_CODE.USAGE, descriptors: [] };
        }

        keys = [options.key];
    }

    // Refused before anything is minted, as deploy does: no value exists for a file that cannot hold it.
    const refused = options.set === true ? ignoreNamedEnvironmentFile(context) : undefined;

    if (refused !== undefined) {
        return refused;
    }

    const generated = keys.map((key) => {
        return { key, value: generateSecretValue() };
    });

    if (options.set === true) {
        return writeGeneratedSecrets(context, generated);
    }

    // Print full `KEY=value` lines to stdout (the user asked to generate them —
    // e.g. to pipe into `wrangler secret put`). Not via the logger, which redacts.
    // In json mode the same values ride the document instead, so stdout stays one blob.
    if (options.format !== "json") {
        for (const entry of generated) {
            process.stdout.write(`${entry.key}=${entry.value}\n`);
        }
    }

    return { code: 0, data: { secrets: generated, subcommand: "generate" }, descriptors: [] };
};

/** Route one validated `env` invocation to its subcommand. */
const dispatchEnvSubcommand = async (context: EnvContext): Promise<EnvCommandResult> => {
    const { options } = context;

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
            context.logger.error(`env: unknown subcommand "${options.subcommand as string}"`);

            return { code: EXIT_CODE.USAGE, descriptors: [] };
        }
    }
};

const runEnvCommand = async (options: EnvCommandOptions): Promise<EnvCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const environment = resolveEnvironment(options);

    if (options.fromDevVars === true && (environment === undefined || (options.subcommand !== "push" && options.subcommand !== "diff"))) {
        options.logger.error("env: --from-dev-vars applies only to `push`/`diff` with --env <name> or --prod");

        return { code: EXIT_CODE.USAGE, descriptors: [] };
    }

    const namedFile = devVariablesFileFor(environment);

    if (namedFile === undefined) {
        options.logger.error(
            `env: --env "${String(environment)}" must be a plain name ([A-Za-z0-9_-]) other than \`example\` — it names the .dev.vars.<name> file`,
        );

        return { code: EXIT_CODE.USAGE, descriptors: [] };
    }

    const devVariablesFile = options.fromDevVars === true ? DEV_VARS_FILE : namedFile;
    const context: EnvContext = {
        cwd,
        devVariablesFile,
        devVariablesPath: join(cwd, devVariablesFile),
        environment,
        // In json mode every human line moves to stderr so stdout carries only
        // the result document.
        logger: options.logger,
        options,
    };
    return dispatchEnvSubcommand(context);
};

const ENV_SUBCOMMANDS: ReadonlySet<string> = new Set(["diff", "doctor", "generate", "get", "list", "push", "set", "unset"]);

/** Narrow a raw argument to a known {@link EnvSubcommand}. */
const isEnvSubcommand = (value: unknown): value is EnvSubcommand => typeof value === "string" && ENV_SUBCOMMANDS.has(value);

/** `lunora env <subcommand>` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<EnvOptions> = defineHandler<EnvOptions, EnvCommandData>(({ argument, cwd, format, logger, options }) => {
    const sub = argument[0];

    if (!isEnvSubcommand(sub)) {
        const message = `env: unknown subcommand "${sub ?? ""}" — expected list | get | set | unset | push | diff | doctor | generate`;

        logger.error(message);

        return { code: EXIT_CODE.USAGE, error: message };
    }

    return runEnvCommand({
        cwd,
        env: options.env,
        format,
        fromDevVars: options.fromDevVars === true,
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
export type { EnvCommandData, EnvCommandOptions, EnvCommandResult, EnvSubcommand };
export { runEnvCommand };
