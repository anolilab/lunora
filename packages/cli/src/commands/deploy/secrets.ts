/**
 * The deploy's secrets gate: which secrets the deployed worker needs, the
 * reminder that `.dev.vars` is not pushed, and minting + pushing the ones that
 * are missing on the target.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { DeployDriver } from "@lunora/config";
import {
    DEV_VARS_FILE,
    generateSecretValue,
    inferLunoraBindings,
    isMintableSecretKey,
    packageNamesFromBindings,
    parseDevVariableEntries,
    requiredSecrets,
    resolveSchemaDirectory,
    upsertDevVariableLine,
    writeDevVariablesFileAtomically,
} from "@lunora/config";
import { join } from "@visulima/path";

import { isSecretKeyName } from "../../../../../shared/secret-key";
import { detectPackageManager, toolchainExecArgs } from "../../util/detect-package-manager";
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
            : `Note: ${driver.name} deploys read no secrets. ${DEV_VARS_FILE} has ${String(keyCount)} key(s) that only the dev server sees; put the values the deployed worker needs in wrangler \`vars\`.`,
    );
};

/** The secret keys this project requires on the deployed worker: its packages' + any secret-typed local var. */
const resolveRequiredSecretKeys = async (cwd: string): Promise<string[]> => {
    let packages: ReadonlyArray<string> = [];

    try {
        packages = packageNamesFromBindings(await inferLunoraBindings({ projectRoot: cwd, schemaDir: resolveSchemaDirectory(cwd) }));
    } catch {
        // Scan failure → fall back to the core secrets + whatever is declared locally.
    }

    const fromPackages = requiredSecrets(packages).map((entry) => entry.key);

    let fromLocal: string[] = [];

    try {
        const devVariablesPath = join(cwd, DEV_VARS_FILE);

        if (existsSync(devVariablesPath)) {
            // Only secret-typed local vars count as "required secrets" on the worker;
            // a non-secret var (e.g. a URL) belongs in wrangler.jsonc `vars`, not secrets.
            fromLocal = parseDevVariableEntries(readFileSync(devVariablesPath, "utf8"))
                .map((entry) => entry.key)
                .filter((key) => isSecretKeyName(key));
        }
    } catch {
        // Unreadable .dev.vars → packages-only.
    }

    return [...new Set([...fromPackages, ...fromLocal])];
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
): Promise<{ minted: ReadonlyArray<{ key: string; value: string }>; ok: boolean }> => {
    const { logger } = options;
    const spawner = options.spawner ?? defaultSpawner;
    const manager = detectPackageManager(cwd);
    const environmentFlag = options.env === undefined ? "" : ` --env ${options.env}`;

    const secretPut = driver.toolchain?.secretPut;

    if (secretPut === undefined) {
        logger.error(`deploy target "${driver.id}" has no secret store; cannot push secrets`);

        return { minted: [], ok: false };
    }

    const minted: { key: string; value: string }[] = [];

    for (const key of keys) {
        const value = generateSecretValue();

        const secretCommand = secretPut({ environment: options.env, key, temporary: options.temporary });
        const exec = toolchainExecArgs(manager, secretCommand);

        // `wrangler secret put <name>` reads the value from stdin, so the value
        // never lands on the command line, in env, or in shell history.
        // eslint-disable-next-line no-await-in-loop -- push sequentially so a failure aborts before the rest.
        const pushResult = await spawner({ args: exec.args, command: exec.command, cwd, input: value });

        if (pushResult.code !== 0) {
            logger.error(
                `failed to push secret ${key} (exit ${String(pushResult.code)}); set it manually with \`wrangler secret put ${key}${environmentFlag}\`.`,
            );

            return { minted, ok: false };
        }

        minted.push({ key, value });
        // Destination is `persistMintedSecrets`'s call — it knows the actual
        // path (bare `.dev.vars` vs. an `--env`-scoped sibling); don't claim
        // one here.
        logger.success(`generated + pushed ${key}`);
    }

    return { minted, ok: true };
};

/**
 * Plain-identifier check before `options.env` is spliced into a filename
 * (`.dev.vars.<env>`) — defense-in-depth; a `--env <name>` naming no
 * declared `wrangler.jsonc` environment is already blocked earlier in the
 * deploy pipeline (`validateWrangler`), so this should be unreachable in
 * practice.
 */
const SAFE_ENV_NAME = /^[\w-]+$/u;

/**
 * The `.gitignore` lines that cover every `.dev.vars`-shaped file this command
 * can write. `.dev.vars` alone is an exact-name pattern and does not match the
 * `.dev.vars.<env>` sibling; the negation keeps a checked-in
 * `.dev.vars.example` visible. Same set the `lunora init` overlay writes.
 *
 * ORDER IS LOAD-BEARING: git is last-match-wins, so the negation only works
 * while it sits below every pattern that would otherwise catch the example file.
 */
const DEV_VARS_IGNORE_PATTERNS = [".dev.vars", ".dev.vars.*", "!.dev.vars.example"];

/** Split a `.gitignore` on either line ending, so a CRLF file's patterns still match. */
const GITIGNORE_LINE = /\r?\n/u;

/**
 * Make sure the project's `.gitignore` covers the `.dev.vars`-shaped file this
 * deploy is about to write a freshly minted PRODUCTION secret into.
 *
 * git's `.dev.vars` pattern matches that exact name and nothing else, so the
 * `.dev.vars.<env>` sibling an `--env` deploy writes was untracked but NOT
 * ignored: the next `git add -A` commits a live admin token / auth secret. Every
 * scaffolded project ships the bare pattern only, and a project not scaffolded
 * by `lunora init` ships whatever its author wrote — so the guard belongs here,
 * at the one place a secret value ever reaches the disk, rather than in each
 * template. Appends only what is missing, and is a no-op once present.
 *
 * Best-effort: a `.gitignore` that cannot be written (read-only checkout, no
 * git at all) must not cost the user the only recoverable copy of a write-only
 * secret, so it warns and lets the write proceed.
 */
const ensureDevVariablesIgnored = (cwd: string, logger: Logger): void => {
    const gitignorePath = join(cwd, ".gitignore");

    try {
        const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
        const lines = new Set(existing.split(GITIGNORE_LINE).map((line) => line.trim()));
        const missing = DEV_VARS_IGNORE_PATTERNS.filter((pattern) => !lines.has(pattern));

        if (missing.length === 0) {
            return;
        }

        // An appended pattern lands BELOW whatever the file already had, and git
        // takes the last match — so appending `.dev.vars.*` under a `.gitignore`
        // that already carried `!.dev.vars.example` silently re-ignored the
        // example file the templates ship. Re-state the negations after the
        // additions instead of reasoning about where the existing ones sit; a
        // repeated negation line is inert, a stranded one is not.
        const additions = missing.some((pattern) => !pattern.startsWith("!"))
            ? [...missing.filter((pattern) => !pattern.startsWith("!")), ...DEV_VARS_IGNORE_PATTERNS.filter((pattern) => pattern.startsWith("!"))]
            : missing;

        const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";

        writeFileSync(gitignorePath, `${existing}${prefix}\n# Lunora — never commit a minted secret\n${additions.join("\n")}\n`, "utf8");
        logger.info(`.gitignore: added ${missing.join(", ")} so the recorded secret cannot be committed`);
    } catch (error) {
        logger.warn(
            `could not update .gitignore (${error instanceof Error ? error.message : String(error)}) — add \`${DEV_VARS_IGNORE_PATTERNS.join("` and `")}\` by hand before committing.`,
        );
    }
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
 * - An explicit `--env <name>`: a DIFFERENT, named environment. Writing that secret into the bare, environment-agnostic `.dev.vars` would silently share it with local dev and with a later no-`--env` `env push` — the exact cross-environment leak an `--env`-scoped deploy is supposed to avoid. So it goes into a sibling `.dev.vars.<name>` instead, after {@link ensureDevVariablesIgnored} has made that filename un-committable. No other command reads `.dev.vars.<name>` today — it exists purely as this deploy's own recoverable record of a value `wrangler secret put` can never return; open it by hand to retrieve the value.
 *
 * Returns the (relative) filename written, or `undefined` when nothing was
 * recorded — the caller threads this through the deploy result so the
 * end-of-deploy summary can point at it too, alongside the KEY-only success
 * log this function prints immediately (a single trailing line naming every
 * minted key once, rather than repeating the file per key).
 */
const persistMintedSecrets = (cwd: string, options: DeployCommandOptions, minted: ReadonlyArray<{ key: string; value: string }>): string | undefined => {
    if (minted.length === 0) {
        return undefined;
    }

    const keys = minted.map((entry) => entry.key).join(", ");

    if (options.env !== undefined && !SAFE_ENV_NAME.test(options.env)) {
        options.logger.warn(
            `${keys}: minted and pushed for --env ${options.env}, but "${options.env}" isn't a safe filename fragment — the value could not be recorded. Capture it manually if you need it again.`,
        );

        return undefined;
    }

    const targetFile = options.env === undefined ? DEV_VARS_FILE : `${DEV_VARS_FILE}.${options.env}`;

    ensureDevVariablesIgnored(cwd, options.logger);

    const devVariablesPath = join(cwd, targetFile);
    let raw = existsSync(devVariablesPath) ? readFileSync(devVariablesPath, "utf8") : "";

    for (const entry of minted) {
        raw = upsertDevVariableLine(raw, entry.key, entry.value);
    }

    writeDevVariablesFileAtomically(devVariablesPath, raw);

    options.logger.success(
        options.env === undefined
            ? `${keys}: value(s) recorded in ${targetFile}`
            : `${keys}: value(s) recorded in ${targetFile} (kept separate from ${DEV_VARS_FILE} so \`lunora dev\` and a plain \`lunora env push\` don't inherit the --env ${options.env} value)`,
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
 * Best-effort detection: a dry-run/preview publishes nothing (skip), and if the
 * worker doesn't exist yet (first deploy) or wrangler isn't authenticated the
 * secret list can't be read — we proceed rather than guess. Any pushing happens
 * BEFORE the deploy spawn so the new version boots with the secrets present.
 */
const offerMissingSecrets = async (cwd: string, options: DeployCommandOptions, interactive: boolean, driver: DeployDriver): Promise<MissingSecretsOutcome> => {
    if (options.dryRun === true || options.preview === true) {
        return {};
    }

    const { logger } = options;
    const environmentFlag = options.env === undefined ? "" : ` --env ${options.env}`;

    let remote: ListRemoteSecretsResult;

    try {
        remote = await (options.secretLister ?? listRemoteSecrets)({ cwd, env: options.env, temporary: options.temporary });
    } catch {
        return {};
    }

    // Can't enumerate (no worker yet / not authed) → nothing actionable to check.
    if (!remote.ok) {
        return {};
    }

    const remoteNames = new Set(remote.names);
    const required = await resolveRequiredSecretKeys(cwd);
    const missing = required.filter((key) => !remoteNames.has(key));

    if (missing.length === 0) {
        return {};
    }

    // No TTY to prompt on → fail fast rather than deploy a worker that will crash
    // on a missing required secret.
    if (!interactive) {
        return {
            error:
                `missing required secret(s) on the deploy target: ${missing.join(", ")}. ` +
                `Set them with \`wrangler secret put <KEY>${environmentFlag}\` ` +
                `(or \`lunora env generate --set\` then \`lunora env push --yes${environmentFlag}\`), then re-deploy.`,
        };
    }

    for (const key of missing.filter((name) => !isMintableSecretKey(name))) {
        logger.warn(`required secret ${key} is not set on the target — set it with: wrangler secret put ${key}${environmentFlag}`);
    }

    const mintable = missing.filter((key) => isMintableSecretKey(key));

    if (mintable.length === 0) {
        return {};
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
        const { minted, ok } = await pushMintableSecrets(cwd, options, mintable, driver);

        // Persist whatever WAS minted even on a partial failure — a pushed
        // secret this function doesn't record is permanently lost (Cloudflare
        // secrets are write-only), so recording it is not conditional on the
        // rest of the batch succeeding. Its path is threaded into the returned
        // outcome even when `ok` is `false`, so an abort never drops a secret
        // that DID get recorded from the caller's view.
        const mintedSecretsFile = persistMintedSecrets(cwd, options, minted);

        if (!ok) {
            return { error: "failed to push required secret(s) — set them manually and re-deploy", mintedSecretsFile };
        }

        return { mintedSecretsFile };
    }

    logger.warn(
        `${String(mintable.length)} required secret(s) not set on the target: ${mintable.join(", ")}. ` +
            `Generate + push with \`lunora env generate --set\` then \`lunora env push --yes${environmentFlag}\`.`,
    );

    return {};
};

export { offerMissingSecrets, warnDevVariablesNotPushed };
