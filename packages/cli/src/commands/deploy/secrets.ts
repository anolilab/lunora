/**
 * The deploy's secrets gate: which secrets the deployed worker needs, the
 * reminder that `.dev.vars` is not pushed, and minting + pushing the ones that
 * are missing on the target.
 */
import { existsSync, readFileSync } from "node:fs";

import type { DeployDriver, DiscoveryCache } from "@lunora/config";
import {
    DEV_VARS_FILE,
    generateSecretValue,
    inferLunoraBindings,
    isPlaceholderValue,
    mintableSecretKeysFor,
    parseDevVariableEntries,
    requiredSecrets,
    resolveSchemaDirectory,
    secretSourcesFromBindings,
    upsertDevVariableLine,
    writeDevVariablesFileAtomically,
} from "@lunora/config";
import { join } from "@visulima/path";

import { isSecretKeyName } from "../../../../../shared/secret-key";
import { detectPackageManager, toolchainExecArgs } from "../../util/detect-package-manager";
import { devVariablesFileFor, ensureDevVariablesIgnored } from "../../util/dev-variables-file";
import type { Logger } from "../../util/logger";
import { defaultSpawner } from "../../util/spawn";
import { createTuiConfirm } from "../../util/tui-prompts";
import type { ListRemoteSecretsResult } from "../../util/wrangler-secrets";
import { listRemoteSecrets } from "../../util/wrangler-secrets";
import type { DeployCommandOptions } from "./types";

/**
 * Print a NON-BLOCKING reminder that `wrangler deploy` does not push secrets.
 * `lunora deploy` ships code + bindings but never uploads `.dev.vars` values —
 * those are pushed separately via `lunora env push`. So a user who edited
 * `.dev.vars` and then deployed would otherwise be left with stale/missing
 * deployed secrets and no signal that anything drifted (Supabase #45242).
 *
 * This only fires when a local `.dev.vars` actually exists and carries at least
 * one key — there's nothing to remind about otherwise. It is a warning only and
 * never aborts the deploy; it does not prompt, so it's safe under
 * `--yes`/non-interactive flows.
 */
const warnDevVariablesNotPushed = (cwd: string, logger: Logger, driver: DeployDriver): void => {
    const devVariablesPath = join(cwd, DEV_VARS_FILE);

    if (!existsSync(devVariablesPath)) {
        return;
    }

    let keyCount: number;

    try {
        keyCount = parseDevVariableEntries(readFileSync(devVariablesPath, "utf8")).length;
    } catch {
        // A read/parse failure here must never block a deploy — skip the reminder.
        return;
    }

    if (keyCount === 0) {
        return;
    }

    // `lunora env push` needs a secret store. Without one (celld), only the dev
    // server reads `.dev.vars` — a deployed value has to live in wrangler `vars`.
    const hasSecretStore = driver.toolchain?.secretPut !== undefined;

    logger.warn(
        hasSecretStore
            ? `Note: \`lunora deploy\` does not push secrets. ${DEV_VARS_FILE} has ${String(keyCount)} key(s); ` +
                  `if you changed them, run \`lunora env push --yes\` to update the deployed secrets.`
            : `Note: ${driver.name} deploys read no secrets. ${DEV_VARS_FILE} has ${String(keyCount)} key(s) that only the dev server sees; ` +
                  `a key the app reads from env must be a \`vars\` entry in the deployed config, one it loads from a secret manager at runtime need not.`,
    );
};

/**
 * The secret keys this project requires on the deployed worker, by source: its packages', and the secret-typed local vars.
 * A named `environment` reads its own `.dev.vars.<name>` as well as the bare file, since `env set --env` declares keys there.
 */
const resolveRequiredSecretKeys = async (
    cwd: string,
    cache: DiscoveryCache | undefined,
    environment?: string,
): Promise<{ fromLocal: string[]; fromPackages: string[]; mintableKeys: ReadonlySet<string> }> => {
    let packages: ReadonlyArray<string> = [];

    try {
        packages = secretSourcesFromBindings(await inferLunoraBindings({ cache, projectRoot: cwd, schemaDir: resolveSchemaDirectory(cwd) }));
    } catch {
        // Scan failure → fall back to the core secrets + whatever is declared locally.
    }

    const fromPackages = [...new Set(requiredSecrets(packages).map((entry) => entry.key))];

    const localFiles = new Set([DEV_VARS_FILE, devVariablesFileFor(environment)].filter((file) => file !== undefined));
    const fromLocal = new Set<string>();

    for (const file of localFiles) {
        try {
            const devVariablesPath = join(cwd, file);

            if (existsSync(devVariablesPath)) {
                // Only secret-typed local vars count as "required secrets" on the worker;
                // a non-secret var (e.g. a URL) belongs in wrangler.jsonc `vars`, not secrets.
                for (const { key } of parseDevVariableEntries(readFileSync(devVariablesPath, "utf8"))) {
                    if (isSecretKeyName(key)) {
                        fromLocal.add(key);
                    }
                }
            }
        } catch {
            // Unreadable file → the keys of the others.
        }
    }

    return { fromLocal: [...fromLocal].filter((key) => !fromPackages.includes(key)), fromPackages, mintableKeys: mintableSecretKeysFor(packages) };
};

/**
 * `wrangler secret put <name>` is Cloudflare's write-only channel — the
 * value never comes back. A previous version of this function minted a fresh
 * value for every key and piped it straight to `secret put`, without binding
 * it to anything the caller could see: the only trace was a key-name log
 * line, so the operator could never again use the secret it just created
 * (studio against prod, `lunora insights`, admin RPCs). Recovery meant minting
 * again, invalidating anything already holding the first value.
 *
 * Now: mint a fresh value for every missing key, push it, and return it in
 * `minted` so the caller can record it in `.dev.vars` — the only local record
 * of a value this function itself must never print, log, or return anywhere
 * else. Sequential; stops on first failure. `ok` is `false` the moment any
 * `secret put` fails — `minted` still holds whatever succeeded before that,
 * because those values are equally unrecoverable if discarded.
 *
 * When a failed `secret bulk` preceded that failure, `minted` is every
 * pending key and `uncertain` names the ones the per-key loop never confirmed:
 * the bulk call is one request whose non-zero exit does not prove nothing was
 * applied (a committed request whose response was lost exits non-zero too), so
 * any of them may be live with its value. Recording a value that was never
 * applied is harmless — the next deploy builds its missing list from the remote
 * secret names alone, so a key still missing is minted fresh and its stale
 * record replaced.
 *
 * Deliberately does NOT reuse an existing local `.dev.vars` value for a
 * missing key, even a non-placeholder one — an earlier version of this
 * function did, on the theory that a real local value needs no fresh
 * disclosure. That reasoning doesn't hold: `isPlaceholderValue` is a marker
 * heuristic (empty / `<…>` / `changeme` / `todo` / …), not a strength check,
 * so a real-but-weak shared dev secret (`AUTH_SECRET="devsecret"`) would
 * silently become the value protecting `--env production`, and the confirm
 * prompt never named which keys were about to be promoted that way. Minting
 * fresh for every missing key is the only choice that can't leak a weak
 * local value into a production credential.
 */
const pushMintableSecrets = async (
    cwd: string,
    options: DeployCommandOptions,
    keys: ReadonlyArray<string>,
    driver: DeployDriver,
): Promise<{ minted: ReadonlyArray<{ key: string; value: string }>; ok: boolean; uncertain: ReadonlyArray<string> }> => {
    const { logger } = options;
    const spawner = options.spawner ?? defaultSpawner;
    const manager = detectPackageManager(cwd);
    const environmentFlag = options.env === undefined ? "" : ` --env ${options.env}`;

    const secretPut = driver.toolchain?.secretPut;

    if (secretPut === undefined) {
        logger.error(`deploy target "${driver.id}" has no secret store; cannot push secrets`);

        return { minted: [], ok: false, uncertain: [] };
    }

    const pending = keys.map((key) => {
        return { key, value: generateSecretValue() };
    });
    // A spawn that rejects (the binary could not start, the child errored) is a failed push like a
    // non-zero exit: thrown out of here, the values already pushed would never be recorded.
    const exitCodeOf = async (descriptor: Parameters<typeof spawner>[0]): Promise<number | string> => {
        try {
            const result = await spawner(descriptor);

            return result.code;
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    };
    const secretBulk = driver.toolchain?.secretBulk;
    let bulkFailed = false;

    // One `wrangler secret bulk` instead of K spawns. A failure falls through to
    // the per-key loop below (same values — a put is idempotent), which is what
    // gives the precise per-key error and the partial `minted` list.
    if (secretBulk !== undefined && pending.length >= 2) {
        const bulkExec = toolchainExecArgs(manager, secretBulk({ environment: options.env, temporary: options.temporary }));
        const bulkCode = await exitCodeOf({
            args: bulkExec.args,
            command: bulkExec.command,
            cwd,
            input: JSON.stringify(Object.fromEntries(pending.map((entry) => [entry.key, entry.value]))),
        });

        if (bulkCode === 0) {
            for (const { key } of pending) {
                logger.success(`generated + pushed ${key}`);
            }

            return { minted: pending, ok: true, uncertain: [] };
        }

        bulkFailed = true;
        logger.warn(`bulk secret push failed (exit ${String(bulkCode)}); retrying one key at a time`);
    }

    const minted: { key: string; value: string }[] = [];

    for (const [index, { key, value }] of pending.entries()) {
        const secretCommand = secretPut({ environment: options.env, key, temporary: options.temporary });
        const exec = toolchainExecArgs(manager, secretCommand);

        // `wrangler secret put <name>` reads the value from stdin, so the value
        // never lands on the command line, in env, or in shell history.
        // eslint-disable-next-line no-await-in-loop -- push sequentially so a failure aborts before the rest.
        const pushCode = await exitCodeOf({ args: exec.args, command: exec.command, cwd, input: value });

        if (pushCode !== 0) {
            logger.error(`failed to push secret ${key} (exit ${String(pushCode)}); set it manually with \`wrangler secret put ${key}${environmentFlag}\`.`);

            if (bulkFailed) {
                return { minted: pending, ok: false, uncertain: pending.slice(index).map((entry) => entry.key) };
            }

            return { minted, ok: false, uncertain: [] };
        }

        minted.push({ key, value });
        // Destination is `persistMintedSecrets`'s call — it knows the actual
        // path (bare `.dev.vars` vs. an `--env`-scoped sibling); don't claim
        // one here.
        logger.success(`generated + pushed ${key}`);
    }

    return { minted, ok: true, uncertain: [] };
};

/**
 * Fold newly-minted secret values into the right `.dev.vars`-shaped file, via
 * the same surgical upsert `env generate --set` uses, written atomically and
 * owner-only (`writeDevVariablesFileAtomically`, matching `@lunora/config`'s
 * own `.dev.vars` writers) — a plain `writeFileSync` would let a process
 * interrupted mid-write truncate the file, destroying every OTHER secret in
 * it alongside the new one, which for a value with no other recoverable copy
 * (Cloudflare secrets are write-only) is worse than not writing at all. A
 * no-op (returning `undefined`) when nothing was minted.
 *
 * Which file depends on `options.env`:
 * - No explicit `--env`: the deploy targets the account's one default environment — the same one `.dev.vars`/`lunora dev`/a plain `lunora env push` already treat as authoritative — so the minted value goes into `.dev.vars` itself, same as `env set`/`env generate --set` would.
 * - An explicit `--env <name>`: a DIFFERENT, named environment. Writing that secret into the bare, environment-agnostic `.dev.vars` would silently share it with local dev and with a later no-`--env` `env push` — the exact cross-environment leak an `--env`-scoped deploy is supposed to avoid. So it goes into a sibling `.dev.vars.<name>` instead ({@link devVariablesFileFor}), after {@link ensureDevVariablesIgnored} has made that filename un-committable. It is the same file `lunora env … --env <name>` reads and writes, so a later `env push --env <name>` re-pushes the recorded value rather than the local dev one.
 *
 * Returns the (relative) filename written, or `undefined` when nothing was
 * recorded — the caller threads this through the deploy result so the
 * end-of-deploy summary can point at it too, alongside the KEY-only success
 * log this function prints immediately (a single trailing line naming every
 * minted key once, rather than repeating the file per key).
 */
const persistMintedSecrets = (
    cwd: string,
    options: DeployCommandOptions,
    minted: ReadonlyArray<{ key: string; value: string }>,
    keepExisting: ReadonlySet<string> = new Set(),
): string | undefined => {
    if (minted.length === 0) {
        return undefined;
    }

    const keys = minted.map((entry) => entry.key).join(", ");

    const targetFile = devVariablesFileFor(options.env);

    if (targetFile === undefined) {
        options.logger.warn(
            `${keys}: minted and pushed for --env ${String(options.env)}, but "${String(options.env)}" isn't a safe filename fragment — the value could not be recorded. Capture it manually if you need it again.`,
        );

        return undefined;
    }

    ensureDevVariablesIgnored(cwd, options.logger);

    const devVariablesPath = join(cwd, targetFile);
    let raw = existsSync(devVariablesPath) ? readFileSync(devVariablesPath, "utf8") : "";
    const present = new Set(parseDevVariableEntries(raw).map((entry) => entry.key));
    // A value whose push may not have landed must not displace one the file already holds: nothing
    // proves the minted value is the live one. Nor may it be dropped: if the request did apply it, the
    // target now lists the key, no later deploy mints it again, and this is its only copy. So it is
    // kept beside the local value as a comment.
    const kept = minted.filter((entry) => keepExisting.has(entry.key) && present.has(entry.key));
    const written = minted.filter((entry) => !kept.includes(entry));

    for (const entry of written) {
        raw = upsertDevVariableLine(raw, entry.key, entry.value);
    }

    for (const entry of kept) {
        raw = `${raw}${raw.endsWith("\n") || raw === "" ? "" : "\n"}# Minted by a deploy whose push failed; the live value if that push applied: ${upsertDevVariableLine("", entry.key, entry.value).trim()}\n`;
    }

    if (kept.length > 0) {
        options.logger.warn(
            `${kept.map((entry) => entry.key).join(", ")}: left the existing value in ${targetFile} active and recorded the minted one beside it as a comment — the failed push may or may not have set it.`,
        );
    }

    if (written.length === 0 && kept.length === 0) {
        return undefined;
    }

    writeDevVariablesFileAtomically(devVariablesPath, raw);

    if (written.length === 0) {
        return targetFile;
    }

    const writtenKeys = written.map((entry) => entry.key).join(", ");

    options.logger.success(
        options.env === undefined
            ? `${writtenKeys}: value(s) recorded in ${targetFile}`
            : `${writtenKeys}: value(s) recorded in ${targetFile} (kept separate from ${DEV_VARS_FILE} so \`lunora dev\` and a plain \`lunora env push\` don't inherit the --env ${options.env} value)`,
    );

    return targetFile;
};

/** {@link offerMissingSecrets}'s outcome: an abort message (deploy must not proceed) and/or the file a minted secret was recorded into, if any. */
interface MissingSecretsOutcome {
    /** Set when the deploy must abort before reaching the wrangler spawn. */
    error?: string;
    /** The `.dev.vars`-shaped file a minted secret was recorded into this run, if any — set even alongside `error` (see the mint-failure branch below), so a partially-recorded secret is never dropped from the caller's view. */
    mintedSecretsFile?: string;
}

/** An angle-bracket template such as `<your-value>`: a placeholder the operator has not replaced. */
const ANGLE_TEMPLATE = /^<[^>]+>$/u;

/**
 * The secrets check for a target with no secret store: its only channel is the
 * `vars` of the config projection the deploy ships (for a Vite virtual entry,
 * the build's config, not the project's), sent as plain strings. An absent,
 * non-string, empty or placeholder value is a credential the worker cannot use.
 *
 * Only the packages' secrets abort the deploy: Lunora reads those from env, so
 * nothing but `vars` can supply them. A key that is required only because
 * `.dev.vars` names it may be one the app loads from a secret manager at
 * runtime, which this check cannot see, so it is a warning.
 */
const checkVariablesForSecrets = async (cwd: string, options: DeployCommandOptions, driver: DeployDriver): Promise<MissingSecretsOutcome> => {
    let deployed: Readonly<Record<string, unknown>>;

    try {
        deployed = driver.projectConfig?.(cwd, "deploy").vars ?? {};
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }

    const isUnset = (key: string): boolean => {
        const value = deployed[key];

        if (typeof value !== "string") {
            return true;
        }

        const trimmed = value.trim();

        if (trimmed === "" || ANGLE_TEMPLATE.test(trimmed)) {
            return true;
        }

        // The token heuristic is for secret-shaped keys: a real URL such as `https://todo.acme.com` is a value.
        return isSecretKeyName(key) && isPlaceholderValue(value);
    };
    const describe = (key: string): string => (Object.hasOwn(deployed, key) ? `${key} (empty or a placeholder)` : key);
    const { fromLocal, fromPackages } = await resolveRequiredSecretKeys(cwd, options.discoveryCache, options.env);
    const localUnset = fromLocal.filter((key) => isUnset(key));

    if (localUnset.length > 0) {
        options.logger.warn(
            `${DEV_VARS_FILE} key(s) not set in the wrangler vars: ${localUnset.map((key) => describe(key)).join(", ")}. ` +
                `${driver.name} has no secret store: a key the app reads from env must be a \`vars\` entry; one it loads from a secret manager at runtime need not.`,
        );
    }

    const missing = fromPackages.filter((key) => isUnset(key));

    if (missing.length === 0) {
        return {};
    }

    return {
        error:
            `missing required secret(s) in the wrangler vars: ${missing.map((key) => describe(key)).join(", ")}. ` +
            `${driver.name} has no secret store and Lunora reads these from env, so each must be a real \`vars\` value in the config the deploy ships — ` +
            `write it there from your secret manager at deploy time rather than committing it. Add them, then re-deploy.`,
    };
};

/** The abort for a failed mint push, naming the keys a failed bulk request may still have set. */
const failedPushOutcome = (logger: Logger, uncertain: ReadonlyArray<string>, mintedSecretsFile: string | undefined): MissingSecretsOutcome => {
    if (uncertain.length === 0) {
        return { error: "failed to push required secret(s) — set them manually and re-deploy", mintedSecretsFile };
    }

    logger.warn(
        `${uncertain.join(", ")}: the failed bulk push may already have set these on the target — their values are recorded ` +
            `${mintedSecretsFile === undefined ? "nowhere (see above)" : `in ${mintedSecretsFile}`} in case it did (as a comment where a local value already existed). The next deploy re-checks the target ` +
            `and replaces the record of any that are still missing with a fresh value; for one it finds set, the recorded value is the live one.`,
    );

    return {
        error: `failed to push required secret(s); ${uncertain.join(", ")} may or may not be set on the target — re-deploy to converge`,
        mintedSecretsFile,
    };
};

/**
 * Before a live deploy, detect required secrets that are NOT yet set on the
 * target worker and resolve them. INTERACTIVE: offer to generate + push the
 * mintable secrets (`AUTH_SECRET`, `LUNORA_ADMIN_TOKEN`, …) in place and flag
 * provider secrets (`RESEND_API_KEY`, `STRIPE_*`) to set by hand.
 * NON-INTERACTIVE (CI): there's nothing to prompt, so a missing required secret
 * aborts the deploy — returns an error message rather than shipping a worker
 * that will crash on a missing secret. Returns `{}` when the deploy may
 * proceed.
 *
 * Best-effort detection: a dry run publishes nothing (skip), and if the
 * worker doesn't exist yet (first deploy) or wrangler isn't authenticated the
 * secret list can't be read — we proceed rather than guess. Any pushing happens
 * BEFORE the deploy spawn so the new version boots with the secrets present.
 */
const offerMissingSecrets = async (cwd: string, options: DeployCommandOptions, interactive: boolean, driver: DeployDriver): Promise<MissingSecretsOutcome> => {
    // A preview uploads the secrets it was given with the deploy itself.
    if (options.dryRun === true || options.isolatedPreview === true) {
        return {};
    }

    // A host with no secret store (celld) takes its secrets as `vars`, so the check
    // is against the projection's `vars`, not a remote list.
    if (driver.toolchain?.secretList === undefined) {
        return checkVariablesForSecrets(cwd, options, driver);
    }

    const { logger } = options;
    const environmentFlag = options.env === undefined ? "" : ` --env ${options.env}`;

    let remote: ListRemoteSecretsResult;

    try {
        remote = await (options.secretLister ?? listRemoteSecrets)({ cwd, env: options.env, target: driver.id, temporary: options.temporary });
    } catch {
        return {};
    }

    // Can't enumerate (no worker yet / not authed) → nothing actionable to check.
    if (!remote.ok) {
        return {};
    }

    const remoteNames = new Set(remote.names);
    const { fromLocal, fromPackages, mintableKeys } = await resolveRequiredSecretKeys(cwd, options.discoveryCache, options.env);
    const missing = [...fromPackages, ...fromLocal].filter((key) => !remoteNames.has(key));

    if (missing.length === 0) {
        return {};
    }

    // No TTY to prompt on → fail fast rather than deploy a worker that will crash
    // on a missing required secret.
    if (!interactive) {
        // Not `env generate --set` + `env push`: with no key named they mint every generatable secret and
        // upload the whole file, rotating the ones already live on the target. An interactive deploy mints
        // exactly the missing ones and records them.
        const generatable = missing.filter((key) => mintableKeys.has(key));
        const providerIssued = missing.filter((key) => !mintableKeys.has(key));
        const fixes = [
            ...providerIssued.map((key) => `\`wrangler secret put ${key}${environmentFlag}\``),
            ...(generatable.length === 0
                ? []
                : [`for ${generatable.join(", ")}, run \`lunora deploy${environmentFlag}\` from a terminal to generate, push and record them`]),
        ];

        return {
            error: `missing required secret(s) on the deploy target: ${missing.join(", ")}. Set them: ${fixes.join("; ")}. Then re-deploy.`,
        };
    }

    for (const key of missing.filter((name) => !mintableKeys.has(name))) {
        logger.warn(`required secret ${key} is not set on the target — set it with: wrangler secret put ${key}${environmentFlag}`);
    }

    const mintable = missing.filter((key) => mintableKeys.has(key));

    if (mintable.length === 0) {
        return {};
    }

    // Cloudflare secrets are write-only: a value minted for an environment with no recordable file
    // would be pushed and then lost, so refuse before asking or pushing anything.
    if (devVariablesFileFor(options.env) === undefined) {
        return {
            error:
                `missing required secret(s) on the deploy target: ${mintable.join(", ")}. --env ${String(options.env)} names no file their values can be recorded in, ` +
                `so they cannot be recorded locally and none were generated. Set them with \`wrangler secret put <KEY>${environmentFlag}\`, then re-deploy.`,
        };
    }

    const confirm = options.secretConfirm ?? createTuiConfirm();

    if (
        await confirm(`${String(mintable.length)} required secret(s) not set on the target (${mintable.join(", ")}). Generate strong values and push them now?`)
    ) {
        // `pushMintableSecrets` returns `ok: false` the moment any `secret put`
        // fails (e.g. auth expired mid-push). Discarding that result used to
        // deploy anyway, shipping a worker still missing the secret it just
        // failed to set — the exact outcome the non-interactive branch above
        // refuses to risk.
        const { minted, ok, uncertain } = await pushMintableSecrets(cwd, options, mintable, driver);

        // Persist whatever WAS minted even on a partial failure — a pushed
        // secret this function doesn't record is permanently lost (Cloudflare
        // secrets are write-only), so recording it is not conditional on the
        // rest of the batch succeeding. Its path is threaded into the returned
        // outcome even when `ok` is `false`, so an abort never drops a secret
        // that DID get recorded from the caller's view.
        const mintedSecretsFile = persistMintedSecrets(cwd, options, minted, new Set(uncertain));

        if (!ok) {
            return failedPushOutcome(logger, uncertain, mintedSecretsFile);
        }

        return { mintedSecretsFile };
    }

    logger.warn(
        `${String(mintable.length)} required secret(s) not set on the target: ${mintable.join(", ")}. ` +
            `Generate + push with \`lunora env generate --set${environmentFlag}\` then \`lunora env push --yes${environmentFlag}\`.`,
    );

    return {};
};

export { offerMissingSecrets, resolveRequiredSecretKeys, warnDevVariablesNotPushed };
