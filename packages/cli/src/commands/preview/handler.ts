/**
 * `lunora preview deploy | list | delete` — an isolated copy of the app per pull request.
 *
 * A preview is its own Worker (so its own Durable Object namespace) with its own D1 databases, KV namespaces
 * and R2 buckets, deployed through the normal deploy pipeline under a transient `env.<preview>` block that is
 * written into `wrangler.jsonc` for the run and restored afterwards. What it owns is kept in an account-side
 * record (see `./registry`), which is all `delete` acts on.
 */
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readServiceBindings, SCHEMA_SNAPSHOT_FILENAME } from "@lunora/codegen";
import { generateSecretValue } from "@lunora/config";
import { applyModify, findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

import { cloudflareRestRequest } from "../../../../../shared/cloudflare-rest";
import { acquireCheckoutLock } from "../../util/checkout-lock";
import type { CloudflareEnvironment } from "../../util/cloudflare-credentials";
import { nonEmpty, resolveCloudflareCredentials } from "../../util/cloudflare-credentials";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { resolveTargetOrError } from "../../util/deploy-target-resolve";
import { EXIT_CODE } from "../../util/exit-code";
import type { HealthFetch } from "../../util/health-probe";
import type { Logger } from "../../util/logger";
import type { OutputFormat } from "../../util/output-format";
import type { Spawner } from "../../util/spawn";
import guardCleanup from "../../util/termination-guard";
import snapshotPreviewConfig from "../../util/wrangler-snapshot";
import type { StreamingFetchLike } from "../data-transfer/shared";
import { provisionBindings, runDeployCommand } from "../deploy/handler";
import { resolveRequiredSecretKeys } from "../deploy/secrets";
import { runSeedCommand } from "../seed/handler";
import { mintAppId, readAppId } from "./app-id";
import type { PreviewOptions } from "./index";
import type { PlannedResource, PreviewConfig, PreviewNames, PreviewPlan, ResourceIds } from "./plan";
import {
    accountsOfEnvironments,
    environmentConfig,
    planPreview,
    PREVIEW_MARKER_VAR,
    previewEnvironmentBlock,
    previewMarker,
    previewNames,
    previewWorkerName,
    productionCollisions,
    resourceKey,
} from "./plan";
import type { PreviewRecord, RecordedResource, Request } from "./registry";
import {
    createResource,
    deleteRecord,
    deleteResource,
    deleteWorker,
    findResource,
    keepLease,
    listRecords,
    lockDatabase,
    readRecord,
    recordedResourceState,
    recordKey,
    registryNamespace,
    releaseLease,
    renewLease,
    takeLease,
    workerMarker,
    workersSubdomain,
    writeRecord,
} from "./registry";

const PREVIEW_SUBCOMMANDS = ["deploy", "list", "delete"] as const;

const REQUEST_TIMEOUT_MS = 15_000;

const ADMIN_TOKEN_KEY = "LUNORA_ADMIN_TOKEN";

/** When set, minted secrets are derived from it per preview Worker, so they survive a redeploy. */
const SECRET_SEED_KEY = "LUNORA_PREVIEW_SECRET_SEED";

/** What each target does instead. Only Cloudflare has the per-Worker namespaces and account resources a preview is made of. */
const UNSUPPORTED_TARGETS: Readonly<Record<string, string>> = {
    celld:
        "celld has no isolated previews: it has no Wrangler environments, and an app's Durable Objects and storage live in its fleet bucket. " +
        "Deploy the copy as its own config, with CELLD_BUCKET naming a bucket of its own, and delete that bucket to remove it.",
    node: "the Node target has no `lunora deploy`, so there is nothing to preview: run a second process with its own database for a copy.",
};

interface PreviewCommandOptions {
    /** Fetch for the admin RPCs the preview runs after deploying (migrations, seed). */
    adminFetch?: StreamingFetchLike;
    cwd?: string;
    dryRun?: boolean;
    /** `--env`: plan the preview from this Wrangler environment (top level with `env.<name>` laid over it). */
    env?: string;
    /** Where credentials and `--secret` values are read; defaults to `process.env`. */
    environment?: CloudflareEnvironment & Record<string, string | undefined>;
    /** Fetch for Cloudflare's REST API. */
    fetch?: typeof globalThis.fetch;
    format?: OutputFormat;
    healthFetch?: HealthFetch;
    healthSleep?: (ms: number) => Promise<void>;
    logger: Logger;
    name?: string;
    /** Secret names the user opted into copying from the environment into the preview. */
    secrets?: ReadonlyArray<string>;
    /** Run `lunora seed` against the preview once it is up. */
    seed?: boolean;
    spawner?: Spawner;
    subcommand: string | undefined;
    target?: string;
    /** `--var KEY=VALUE` overrides, applied over production's `vars`. */
    vars?: ReadonlyArray<string>;
}

interface PreviewSummary {
    environment: string;
    name: string;
    resources: { binding: string; id?: string; kind: string; name: string }[];
    url?: string;
    worker: string;
}

interface PreviewCommandData {
    deleted?: PreviewSummary;
    plan?: PreviewSummary;
    preview?: PreviewSummary;
    previews?: PreviewSummary[];
}

interface PreviewCommandResult {
    code: number;
    data?: PreviewCommandData;
    error?: string;
}

const fail = (logger: Logger, error: string, code: number = EXIT_CODE.USAGE): PreviewCommandResult => {
    logger.error(error);

    return { code, error };
};

const summarize = (record: PreviewRecord): PreviewSummary => {
    return { environment: record.environment, name: record.name, resources: record.resources, url: record.url, worker: record.worker };
};

interface PreviewContext {
    /** `lunora.appId` from `package.json`; `undefined` until one is minted. */
    appId: string | undefined;
    /** The committed config as a whole: a `--env` preview is planned from one environment but must collide with none of it. */
    committed?: PreviewConfig;
    config: PreviewConfig;
    cwd: string;
    wranglerPath: string;
}

/** The committed config, read only on a target a preview exists for. */
const loadContext = (options: PreviewCommandOptions): { context: PreviewContext; error?: never } | { context?: never; error: string } => {
    const cwd = options.cwd ?? process.cwd();
    const resolved = resolveTargetOrError(cwd, options.target);

    if (resolved.target === undefined) {
        return { error: resolved.error ?? "unknown deploy target" };
    }

    if (resolved.target !== "cloudflare") {
        return { error: `lunora preview: ${UNSUPPORTED_TARGETS[resolved.target] ?? `target "${resolved.target}" has no isolated previews.`}` };
    }

    const wranglerPath = findWranglerFile(cwd);
    const config = wranglerPath === undefined ? undefined : readWranglerJsonc<PreviewConfig>(wranglerPath).parsed;

    if (wranglerPath === undefined || config === undefined) {
        return { error: "lunora preview needs a readable wrangler.jsonc (or wrangler.json) in the project root" };
    }

    return { context: { config, cwd, appId: readAppId(cwd), wranglerPath } };
};

/**
 * The config whose `account_id` `delete` and `list` use: `--env`'s environment, as `deploy` does, since that is where the
 * preview was made. Without `--env`, an environment that names another account makes the answer ambiguous, and guessing
 * would look for the registry in the wrong account.
 */
const accountConfig = (config: PreviewConfig, options: PreviewCommandOptions): { config: PreviewConfig; error?: never } | { config?: never; error: string } => {
    if (options.env !== undefined) {
        return environmentConfig(config, options.env);
    }

    const elsewhere = accountsOfEnvironments(config);

    if (elsewhere.length > 0 && nonEmpty((options.environment ?? process.env).CLOUDFLARE_ACCOUNT_ID) === undefined) {
        return {
            error: `environment(s) ${elsewhere.join(", ")} name an account_id other than the top level's, so the account to look in is not clear: pass --env <name> to use that environment's account, or set CLOUDFLARE_ACCOUNT_ID`,
        };
    }

    return { config };
};

/** The REST caller for the account, or why there is none. Every preview call needs it: the record lives in the account. */
const accountRequest = (options: PreviewCommandOptions, config: PreviewConfig): { error: string; request?: never } | { error?: never; request: Request } => {
    const { accountId, token } = resolveCloudflareCredentials(options.environment ?? process.env, config.account_id);

    if (accountId === undefined || token === undefined) {
        return {
            error: "lunora preview needs CLOUDFLARE_API_TOKEN (Workers Scripts, D1, Workers KV Storage and Workers R2 Storage: Edit) and CLOUDFLARE_ACCOUNT_ID (or `account_id` in wrangler.jsonc)",
        };
    }

    return {
        request: async (path, init) =>
            cloudflareRestRequest({
                accountId,
                apiToken: token,
                ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                init: { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
                path,
            }),
    };
};

/** The `--var KEY=VALUE` overrides, or why one cannot be used. */
const parseVariables = (entries: ReadonlyArray<string>): { error: string; variables?: never } | { error?: never; variables: Record<string, string> } => {
    const variables: Record<string, string> = {};

    for (const entry of entries) {
        const separator = entry.indexOf("=");
        const key = separator === -1 ? "" : entry.slice(0, separator);

        if (key === "") {
            return { error: `--var ${entry}: expected KEY=VALUE` };
        }

        if (key === PREVIEW_MARKER_VAR) {
            return { error: `--var ${key}: the preview sets ${key} itself; \`delete\` relies on it` };
        }

        variables[key] = entry.slice(separator + 1);
    }

    return { variables };
};

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The secrets the preview deploys with: a value for every key Lunora can mint (the admin token always, so this
 * run can migrate and seed), and the value from the environment for each `--secret` the user named. Production's
 * values are never read: Cloudflare cannot return them, and a preview must not hold them unasked.
 *
 * Cloudflare secrets are write-only, so a minted value cannot be read back for the next deploy. With
 * `LUNORA_PREVIEW_SECRET_SEED` set it is derived from the seed, the preview Worker and the key instead, which
 * keeps sessions and tokens valid across redeploys without storing a value anywhere; without it, each deploy
 * mints afresh.
 */
const previewSecrets = async (
    cwd: string,
    config: PreviewConfig,
    worker: string,
    options: PreviewCommandOptions,
): Promise<{ adminToken: string; error?: never; missing: string[]; values: Record<string, string> } | { error: string }> => {
    const environment = options.environment ?? process.env;
    const values: Record<string, string> = {};
    const seed = environment[SECRET_SEED_KEY];
    const mint = (key: string): string =>
        seed === undefined || seed === "" ? generateSecretValue() : createHmac("sha256", seed).update(`${worker}/${key}`).digest("hex");

    for (const key of options.secrets ?? []) {
        const value = environment[key];

        if (value === undefined || value === "") {
            return { error: `--secret ${key}: ${key} is not set in the environment, so there is no value to give the preview` };
        }

        values[key] = value;
    }

    const { fromLocal, fromPackages, mintableKeys } = await resolveRequiredSecretKeys(cwd, undefined);

    for (const key of [...fromPackages, ...fromLocal, ADMIN_TOKEN_KEY]) {
        if (values[key] === undefined && (mintableKeys.has(key) || key === ADMIN_TOKEN_KEY)) {
            values[key] = mint(key);
        }
    }

    const missing = [...new Set([...fromPackages, ...fromLocal])].filter((key) => values[key] === undefined);
    // Wrangler refuses a first deploy without the config's required secrets; say so before anything is created.
    const required = Array.isArray(config.secrets?.required)
        ? (config.secrets.required as unknown[]).filter((key): key is string => typeof key === "string")
        : [];
    const unmet = required.filter((key) => values[key] === undefined);

    if (unmet.length > 0) {
        return { error: `the config requires ${unmet.join(", ")}, which a preview only gets when you pass ${unmet.map((key) => `--secret ${key}`).join(" ")}` };
    }

    return { adminToken: values[ADMIN_TOKEN_KEY] ?? "", missing, values };
};

/** A resource the record already lists: its id, once checked that the id still names that resource. */
const reuseRecorded = async (request: Request, plan: PreviewPlan, recorded: RecordedResource, logger: Logger): Promise<string> => {
    const state = await recordedResourceState(request, recorded);

    // A recorded id that no longer names the recorded resource is never bound: it may be anyone's now.
    if (state !== "present") {
        throw new Error(
            `the record lists ${recorded.kind} "${recorded.name}" (${recorded.id}), which is ${state === "missing" ? "gone" : "now a different resource"}; run \`lunora preview delete ${plan.slug}\`, then deploy again`,
        );
    }

    logger.info(`reusing preview ${recorded.kind} "${recorded.name}" for ${recorded.binding}`);

    return recorded.id;
};

/** How many times the confirming record write is tried before the resource just made is taken back. */
const CONFIRM_ATTEMPTS = 3;

/**
 * Write the record with the new resource confirmed. If it cannot be written, the resource is removed again by the id its
 * create returned: that id is the proof it is this run's, which a pending entry found by name afterwards is not.
 */
const confirmClaim = async (request: Request, namespace: string, record: PreviewRecord, claim: RecordedResource): Promise<void> => {
    let failure: unknown;

    for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop -- a retry only after the previous write failed
            await writeRecord(request, namespace, record);

            return;
        } catch (error) {
            failure = error;
        }
    }

    try {
        await deleteResource(request, claim);
        record.resources.splice(record.resources.indexOf(claim), 1);
        await writeRecord(request, namespace, record).catch(() => undefined);
    } catch {
        // Stays pending; delete reports it rather than guessing.
        // eslint-disable-next-line no-param-reassign -- the claim is the live copy of the record's entry
        claim.pending = true;
    }

    throw new Error(`${reason(failure)}; the ${claim.kind} "${claim.name}" just made could not be recorded, so it was removed again`);
};

/**
 * Make one planned resource and return its id. The record names it before the create call and confirms it after,
 * so a resource can never exist unrecorded: if the confirming write fails, delete finds it by the claim.
 */
const createClaimed = async (request: Request, namespace: string, record: PreviewRecord, planned: PlannedResource, logger: Logger): Promise<string> => {
    let claim = record.resources.find((resource) => resource.kind === planned.kind && resource.binding === planned.binding);

    if (claim === undefined) {
        const existing = await findResource(request, planned.kind, planned.name);

        if (existing !== undefined) {
            throw new Error(
                `a ${planned.kind} resource named "${planned.name}" already exists but no preview record says this preview created it; refusing to bind or later delete it. Rename or remove it, then deploy again.`,
            );
        }

        claim = { binding: planned.binding, id: planned.kind === "r2" ? planned.name : "", kind: planned.kind, name: planned.name, pending: true };
        record.resources.push(claim);
        await writeRecord(request, namespace, record);
    }

    claim.id = await createResource(request, planned.kind, planned.name);
    delete claim.pending;
    await confirmClaim(request, namespace, record, claim);
    logger.success(`created preview ${planned.kind} "${planned.name}" for ${planned.binding}`);

    return claim.id;
};

/**
 * Give every planned resource its id: the recorded one, or a new resource claimed in the record before it is made.
 * A resource that already exists under a preview name but is not on record is never adopted: nothing shows
 * it is the preview's, and deleting the preview later would delete it.
 */
const ensureOne = async (
    request: Request,
    namespace: string,
    plan: PreviewPlan,
    record: PreviewRecord,
    planned: PlannedResource,
    logger: Logger,
    check: () => void,
): Promise<string> => {
    const recorded = record.resources.find((resource) => resource.kind === planned.kind && resource.binding === planned.binding);
    // A claim whose create happened is confirmed now; one whose create did not is made below.
    check();

    if (recorded?.pending === true) {
        // The record only claims it. Whatever carries the name now may be a leftover of an interrupted deploy of this
        // preview, or something another actor made since; nothing tells them apart, so it is never adopted.
        if ((await findResource(request, planned.kind, planned.name)) !== undefined) {
            throw new Error(
                `a ${planned.kind} resource named "${planned.name}" exists, but the record only claims it (a deploy was interrupted between creating it and confirming it), so nothing shows it is this preview's and it is left alone. If it is, delete it by hand, then deploy again`,
            );
        }

        return createClaimed(request, namespace, record, planned, logger);
    }

    return recorded === undefined ? createClaimed(request, namespace, record, planned, logger) : reuseRecorded(request, plan, recorded, logger);
};

const ensureResources = async (
    request: Request,
    namespace: string,
    plan: PreviewPlan,
    record: PreviewRecord,
    logger: Logger,
    check: () => void,
): Promise<ResourceIds> => {
    const ids = new Map<string, string>();

    for (const planned of plan.resources) {
        // eslint-disable-next-line no-await-in-loop -- one resource at a time, each claimed in the record before it is made
        ids.set(resourceKey(planned.kind, planned.binding), await ensureOne(request, namespace, plan, record, planned, logger, check));
    }

    return ids;
};

/** The planned resources that exist in the account under the preview's names but are not on `record`. */
const unrecordedResources = async (request: Request, planned: ReadonlyArray<PlannedResource>, record: PreviewRecord | undefined): Promise<string[]> => {
    const recorded = new Set((record?.resources ?? []).map((resource) => `${resource.kind}:${resource.name}`));
    const candidates = planned.filter((resource) => !recorded.has(`${resource.kind}:${resource.name}`));
    const found = await Promise.all(
        candidates.map(async (resource) => ((await findResource(request, resource.kind, resource.name)) === undefined ? [] : [resource])),
    );

    return found.flat().map((resource) => `${resource.kind} "${resource.name}"`);
};

/**
 * The record for preview `slug`: under the project's id, or, for a preview made before app ids existed, under
 * `<production Worker>/<slug>`, in which case it is re-keyed under the id (written first, then the old key removed).
 * The old-key record must be the one this CLI would have written for that Worker and slug, else it is refused.
 */
const recordFor = async (
    request: Request,
    namespace: string,
    appId: string | undefined,
    production: string,
    slug: string,
    logger: Logger,
    rekey = true,
): Promise<PreviewRecord | undefined> => {
    if (appId !== undefined) {
        const current = await readRecord(request, namespace, recordKey(appId, slug));

        if (current !== undefined) {
            return current;
        }
    }

    const legacy = await readRecord(request, namespace, recordKey(production, slug));

    if (legacy === undefined) {
        return undefined;
    }

    if (legacy.appId !== undefined || legacy.production !== production || legacy.name !== slug || legacy.worker !== previewWorkerName(production, slug)) {
        throw new Error(`the record at "${recordKey(production, slug)}" is not the one this CLI wrote for that Worker and preview; refusing to act on it`);
    }

    if (appId === undefined) {
        throw new Error(
            `preview "${slug}" is recorded under the Worker name, from before projects had an id. Add an app id to package.json (\`"lunora": { "appId": "${randomUUID()}" }\`), commit it, and run this again: it re-keys the record`,
        );
    }

    const rekeyed: PreviewRecord = { ...legacy, appId };

    // A dry run shows what it would find and changes nothing in the account.
    if (!rekey) {
        return rekeyed;
    }

    await writeRecord(request, namespace, rekeyed);
    await deleteRecord(request, namespace, legacy);
    logger.warn(`preview "${slug}" was recorded under the Worker name "${production}"; it is now recorded under project ${appId}`);

    return rekeyed;
};

/** Why a deploy must not take the record it read (and the Worker and resources under the preview's names). */
const recordRefusal = async (
    request: Request,
    plan: PreviewPlan,
    existing: PreviewRecord | undefined,
    workerExists: boolean,
): Promise<{ code: number; error: string } | undefined> => {
    // The marker is only a var: without a record, nothing shows this preview owns the Worker that carries it.
    if (existing === undefined && workerExists) {
        return {
            code: EXIT_CODE.USAGE,
            error: `a Worker named "${plan.worker}" exists but no preview record says this preview deployed it; refusing to deploy over it`,
        };
    }

    if (existing !== undefined && existing.worker !== plan.worker) {
        return {
            code: EXIT_CODE.USAGE,
            error: `the record for preview "${plan.slug}" names Worker "${existing.worker}", not "${plan.worker}" (the app was renamed since it was deployed); run \`lunora preview delete ${plan.slug}\` first, then deploy it again`,
        };
    }

    // KV is eventually consistent, so the record read can predate resources an earlier run made. Writing it back
    // would erase them from the newer record; stop before any write instead.
    const unrecorded = await unrecordedResources(request, plan.resources, existing);

    return unrecorded.length === 0
        ? undefined
        : {
              code: EXIT_CODE.FAILURE,
              error: `${unrecorded.join(", ")} already exist(s) but no preview record read says this preview created it, so nothing was written or deployed. If a deploy of this preview just ran, its record may not have reached this location yet: run the deploy again. Otherwise rename or remove it, then deploy again.`,
          };
};

/** Write the secrets to a private temporary file for `wrangler deploy --secrets-file`; the caller removes the directory. */
const writeSecretsFile = (values: Record<string, string>): { directory: string; path: string } => {
    const directory = mkdtempSync(join(tmpdir(), "lunora-preview-"));
    const path = join(directory, "secrets.json");

    writeFileSync(path, JSON.stringify(values), { encoding: "utf8", mode: 0o600 });

    return { directory, path };
};

const planSummary = (plan: PreviewPlan): PreviewSummary => {
    return { environment: plan.environment, name: plan.slug, resources: plan.resources, worker: plan.worker };
};

const reportPlan = (logger: Logger, plan: PreviewPlan, block: Record<string, unknown>): void => {
    logger.info(`dry run: preview "${plan.slug}" would deploy Worker "${plan.worker}" (env.${plan.environment}, its own Durable Object namespace)`);

    for (const resource of plan.resources) {
        logger.info(`  ${resource.kind} "${resource.name}" for ${resource.binding} (created, or reused when this preview's record lists it)`);
    }

    // `vars` are copied from production and overridden with `--var`; a dry run lands in terminals and CI logs, so show their names only.
    const { vars } = block as { vars?: Record<string, unknown> };
    const shown = vars === undefined ? block : { ...block, vars: Object.fromEntries(Object.keys(vars).map((key) => [key, "<redacted>"])) };

    logger.info(`  env.${plan.environment}: ${JSON.stringify(shown)}`);
};

const heldMessage = (slug: string, until: string): string =>
    `another run is deploying or deleting preview "${slug}" (its hold lapses at ${until}); wait for it. A run that crashed lets go by itself`;

/** The run finished but its hold was taken by another meanwhile: whatever it did is not to be trusted to have been alone. */
const holdLost = (logger: Logger, slug: string, result: PreviewCommandResult): PreviewCommandResult => {
    const error = `the hold on preview "${slug}" was lost while this run worked, so another run may have changed it too; check it with \`lunora preview list\` and run \`lunora preview delete ${slug}\` if it looks wrong`;

    logger.error(error);

    return { ...result, code: result.code === EXIT_CODE.SUCCESS ? EXIT_CODE.FAILURE : result.code, error };
};

/** Whether this run still holds its preview; the renewal timer clears it when it cannot say so any more. */
interface Hold {
    lost: boolean;
    /** Asks D1 whether the hold is still this run's; throws if not. Called right before a registry write that must not land late. */
    verify: () => Promise<void>;
}

/** Stop before the next step, not after the last one, once the hold cannot be vouched for. */
const checkHeld = (hold: Hold, slug: string): void => {
    if (hold.lost) {
        throw new Error(
            `the hold on preview "${slug}" can no longer be vouched for, so this run stopped before changing anything more; check it with \`lunora preview list\`, then run again`,
        );
    }
};

/** What a deploy has settled before it creates anything: the secrets, the workers.dev subdomain, the registry and its hold on this preview. */
interface ShipPrerequisites {
    appId: string;
    hold: Hold;
    namespace: string;
    secrets: { adminToken: string; values: Record<string, string> };
    subdomain: string;
}

const shipHeld = async (
    context: PreviewContext,
    plan: PreviewPlan,
    variables: Readonly<Record<string, string>>,
    options: PreviewCommandOptions,
    request: Request,
    prerequisites: ShipPrerequisites,
): Promise<PreviewCommandResult> => {
    const { config, cwd, wranglerPath } = context;
    const { logger } = options;
    const { appId, hold, namespace, secrets, subdomain } = prerequisites;

    let record: PreviewRecord;
    let ids: ResourceIds;
    const url = `https://${plan.worker}.${subdomain}.workers.dev`;

    try {
        // A Worker with the preview's name that this command did not deploy is someone else's: never deploy over it.
        const existingWorker = await workerMarker(request, plan.worker, PREVIEW_MARKER_VAR);

        if (existingWorker.exists && existingWorker.marker !== previewMarker(plan)) {
            return fail(logger, `a Worker named "${plan.worker}" already exists and was not deployed as preview "${plan.slug}"; refusing to deploy over it`);
        }

        const now = new Date().toISOString();
        const existing = await recordFor(request, namespace, appId, plan.production, plan.slug, logger);

        const refusal = await recordRefusal(request, plan, existing, existingWorker.exists);

        if (refusal !== undefined) {
            return fail(logger, refusal.error, refusal.code);
        }

        // Before anything is created or written: a resource this preview already owns that production now points at is a
        // refusal, not something to find out after more storage was made beside it.
        const owned = productionCollisions(context.committed ?? config, [
            plan.worker,
            ...(existing?.resources ?? []).flatMap((resource) => [resource.id, resource.name]),
        ]);

        if (owned.length > 0) {
            return fail(logger, `preview "${plan.slug}" would bind production's ${owned.join(", ")}; refusing to deploy, nothing was created`);
        }

        record = existing ?? {
            createdAt: now,
            environment: plan.environment,
            name: plan.slug,
            production: plan.production,
            appId,
            ...(plan.sourceEnv === undefined ? {} : { sourceEnv: plan.sourceEnv }),
            resources: [],
            updatedAt: now,
            version: 1,
            worker: plan.worker,
        };
        await writeRecord(request, namespace, record);
        ids = await ensureResources(request, namespace, plan, record, logger, () => {
            checkHeld(hold, plan.slug);
        });
    } catch (error) {
        return fail(logger, `preview "${plan.slug}": ${reason(error)}`, EXIT_CODE.FAILURE);
    }

    const collisions = productionCollisions(context.committed ?? config, [...ids.values()]);

    if (collisions.length > 0) {
        return fail(logger, `preview "${plan.slug}" would bind production's ${collisions.join(", ")}; refusing to deploy`);
    }

    const text = readFileSync(wranglerPath, "utf8");

    writeFileSync(wranglerPath, applyModify(text, ["env", plan.environment], previewEnvironmentBlock(config, plan, ids, variables, url)), "utf8");

    const secretsFile = writeSecretsFile(secrets.values);
    const disarmSecrets = guardCleanup(() => {
        rmSync(secretsFile.directory, { force: true, recursive: true });
    });

    try {
        checkHeld(hold, plan.slug);

        const deployed = await runDeployCommand({
            // A preview starts from its own data; production's schema baseline does not describe it.
            allowSchemaDrift: true,
            cwd,
            env: plan.environment,
            fetchImpl: options.adminFetch,
            format: options.format,
            healthCheck: true,
            healthFetch: options.healthFetch,
            healthSleep: options.healthSleep,
            interactive: false,
            isolatedPreview: true,
            logger,
            migrate: true,
            migrateToken: secrets.adminToken,
            migrateUrl: url,
            migrateYes: true,
            secretsFile: secretsFile.path,
            spawner: options.spawner,
            target: "cloudflare",
        });

        // The URL built from the Worker's name and the account's subdomain, not one parsed out of wrangler's output: the
        // seed carries the preview's admin token, which must only go where the migrations went.
        record.url = url;
        record.updatedAt = new Date().toISOString();
        // The deploy may have outlasted the hold: another run may own the record by now, and this write must not undo it.
        await hold.verify();
        await writeRecord(request, namespace, record);

        if (deployed.code !== 0) {
            return { code: deployed.code, data: { preview: summarize(record) }, error: deployed.error ?? `preview "${plan.slug}" did not deploy` };
        }
    } catch (error) {
        return fail(logger, `preview "${plan.slug}": ${reason(error)}`, EXIT_CODE.FAILURE);
    } finally {
        rmSync(secretsFile.directory, { force: true, recursive: true });
        disarmSecrets();
    }

    if (options.seed === true) {
        const seeded = await runSeedCommand({
            cwd,
            fetchImpl: options.adminFetch,
            format: options.format,
            logger,
            prod: true,
            token: secrets.adminToken,
            url: record.url,
            yes: true,
        });

        if (seeded.code !== 0) {
            return { code: seeded.code, data: { preview: summarize(record) }, error: seeded.error ?? `seeding preview "${plan.slug}" failed` };
        }
    }

    logger.success(`preview "${plan.slug}" is live at ${record.url ?? url} — remove it with \`lunora preview delete ${plan.slug}\``);

    return { code: EXIT_CODE.SUCCESS, data: { preview: summarize(record) } };
};

/**
 * Everything after the plan. Every precondition that can refuse the preview (secrets, the workers.dev subdomain, the
 * registry, another run holding this preview) is settled first, so a refused preview leaves nothing in the account.
 */
const shipPreview = async (
    context: PreviewContext,
    plan: PreviewPlan,
    variables: Readonly<Record<string, string>>,
    options: PreviewCommandOptions,
    request: Request,
): Promise<PreviewCommandResult> => {
    const { appId, config, cwd } = context;
    const { logger } = options;

    if (appId === undefined) {
        return fail(logger, "the project has no id to key the preview record by");
    }

    const secrets = await previewSecrets(cwd, config, plan.worker, options);

    if (secrets.error !== undefined) {
        return fail(logger, secrets.error);
    }

    for (const key of secrets.missing) {
        logger.warn(`the preview has no ${key}: production's is never copied. Pass --secret ${key} with ${key} set in the environment to give it one.`);
    }

    let namespace: string;
    let subdomain: string;
    let database: string;
    let token: string;

    try {
        subdomain = await workersSubdomain(request);
        namespace = (await registryNamespace(request, true)) ?? "";

        database = await lockDatabase(request);

        const lease = await takeLease(request, database, appId, plan.slug);

        if (lease.held !== undefined) {
            return fail(logger, heldMessage(plan.slug, lease.held));
        }

        ({ token } = lease);
    } catch (error) {
        return fail(logger, `preview "${plan.slug}": ${reason(error)}`, EXIT_CODE.FAILURE);
    }

    const hold: Hold = {
        lost: false,
        verify: async () => {
            if (!(await renewLease(request, database, appId, plan.slug, token))) {
                hold.lost = true;
                throw new Error(`the hold on preview "${plan.slug}" is no longer this run's, so its record was left as the other run has it`);
            }
        },
    };
    const stop = keepLease(request, database, appId, plan.slug, token, () => {
        hold.lost = true;
    });
    // An interrupt skips the `finally` below: the hold is also let go of there, or the preview stays locked for its lifetime.
    const disarm = guardCleanup(async () => {
        stop();
        await releaseLease(request, database, appId, plan.slug, token);
    });

    try {
        const result = await shipHeld(context, plan, variables, options, request, { appId, hold, namespace, secrets, subdomain });

        return hold.lost ? holdLost(logger, plan.slug, result) : result;
    } finally {
        stop();
        await releaseLease(request, database, appId, plan.slug, token);
        disarm();
    }
};

/**
 * The app id a deploy keys its record by: the committed one, or a fresh one written to `package.json` for the
 * user to commit. A CI runner never mints: its checkout is thrown away, so every run would key a new record and
 * nothing could find the preview again to delete it. A dry run writes nothing.
 */
const resolveAppId = (
    context: PreviewContext,
    options: PreviewCommandOptions,
): { appId?: never; error: string } | { appId: string | undefined; error?: never } => {
    if (context.appId !== undefined) {
        return { appId: context.appId };
    }

    const environment = options.environment ?? process.env;
    const unusable = `package.json has a "lunora.appId" that is not a UUID, or no \`lunora\` object this CLI can add one to`;

    if (options.dryRun === true) {
        options.logger.info("  app id: none yet; the first deploy writes one to package.json for you to commit");

        return { appId: undefined };
    }

    if (environment["CI"] !== undefined && environment["CI"] !== "" && environment["CI"] !== "false") {
        return {
            error: `package.json has no "lunora.appId", and a CI run cannot mint one (its checkout is discarded, so the preview could never be found again to delete). Commit \`"lunora": { "appId": "${randomUUID()}" }\` to package.json`,
        };
    }

    const minted = mintAppId(context.cwd);

    if (minted === undefined) {
        return { error: unusable };
    }

    options.logger.warn(`wrote an app id to package.json ("lunora.appId"); commit it so CI finds this project's previews`);

    return { appId: minted };
};

const deployPreview = async (context: PreviewContext, options: PreviewCommandOptions, name: string): Promise<PreviewCommandResult> => {
    const { cwd } = context;
    const { logger } = options;
    const parsed = parseVariables(options.vars ?? []);

    if (parsed.error !== undefined) {
        return fail(logger, parsed.error);
    }

    const { variables } = parsed;
    const lock = acquireCheckoutLock(cwd);

    if (lock.error !== undefined) {
        return fail(logger, lock.error);
    }

    // Minted before the config snapshot below, which would otherwise restore package.json without it.
    const identified = resolveAppId(context, options);

    if (identified.error !== undefined) {
        lock.release();

        return fail(logger, identified.error);
    }

    // The preview's env block, and whatever reconcile adds to the top level, exist only for this run. The snapshot is
    // taken inside the guarded block below: if reading a config file fails, the lock must still be let go of.
    let restore: () => void = () => undefined;
    // The deploy pipeline does not re-bless the baseline for a preview, but codegen writes a first one when there is none,
    // and the file is production's: it is put back to the exact bytes it had, or removed if it did not exist.
    const baselinePath = join(cwd, "lunora", SCHEMA_SNAPSHOT_FILENAME);
    const baselineBefore = existsSync(baselinePath) ? readFileSync(baselinePath) : undefined;
    const putBack = (): void => {
        restore();
        lock.release();

        if (baselineBefore === undefined) {
            rmSync(baselinePath, { force: true });
        } else if (!baselineBefore.equals(existsSync(baselinePath) ? readFileSync(baselinePath) : Buffer.alloc(0))) {
            writeFileSync(baselinePath, baselineBefore);
        }
    };
    // A killed process runs no `finally`: an interrupt must also leave the config as it found it and let go of the lock.
    const disarm = guardCleanup(putBack);

    try {
        restore = snapshotPreviewConfig(cwd);

        // Bindings do not inherit into an environment: reconcile the top level first, so the env block copies
        // every binding the code needs, not the ones the last deploy happened to write.
        await provisionBindings(cwd, logger, undefined, "cloudflare", undefined);

        const { services } = readServiceBindings(cwd);

        // Services deploy under their own names, which are production's, and the app's bindings reach them.
        if (services.length > 0) {
            return fail(
                logger,
                `this app cannot be previewed in isolation yet: it declares lunora.config services (${services.map((service) => service.name).join(", ")}), which a preview would share with production`,
            );
        }

        const committed = readWranglerJsonc<PreviewConfig>(context.wranglerPath).parsed ?? context.config;
        const sourced = options.env === undefined ? { config: committed } : environmentConfig(committed, options.env);

        if (sourced.error !== undefined) {
            return fail(logger, sourced.error);
        }

        const { config } = sourced;
        const planned = planPreview(config, name, options.env);

        if (planned.error !== undefined) {
            return fail(logger, planned.error);
        }

        const { plan } = planned;
        const collisions = productionCollisions(committed, [plan.worker, ...plan.resources.map((resource) => resource.name)]);

        if (collisions.length > 0) {
            return fail(logger, `preview "${plan.slug}" names collide with production's ${collisions.join(", ")}; name the preview differently`);
        }

        if (options.dryRun === true) {
            // Placeholder ids: a dry run makes no API call, so it shows the block's shape, not the account's ids.
            const ids = new Map(plan.resources.map((resource) => [resourceKey(resource.kind, resource.binding), `<${resource.name}>`]));

            reportPlan(logger, plan, previewEnvironmentBlock(config, plan, ids, variables, `https://${plan.worker}.<your-subdomain>.workers.dev`));
            logger.info(
                `  secrets: every one Lunora can mint, fresh${(options.secrets ?? []).length > 0 ? `; from the environment: ${(options.secrets ?? []).join(", ")}` : ""}`,
            );

            return { code: EXIT_CODE.SUCCESS, data: { plan: planSummary(plan) } };
        }

        const access = accountRequest(options, config);

        if (access.error !== undefined) {
            return fail(logger, access.error, EXIT_CODE.AUTH);
        }

        return await shipPreview({ ...context, committed, config, appId: identified.appId }, plan, variables, options, access.request);
    } finally {
        putBack();
        disarm();
    }
};

/**
 * Delete one recorded resource, but only what the record proves this preview made: a confirmed entry whose id still names
 * a resource of the recorded name. An entry that was only claimed is never deleted by name, since whatever carries the name
 * may be another actor's; it is reported and stays on record. False when the resource is still there.
 */
const removeRecorded = async (request: Request, entry: RecordedResource, logger: Logger): Promise<boolean> => {
    try {
        if (entry.pending === true) {
            if ((await findResource(request, entry.kind, entry.name)) === undefined) {
                return true;
            }

            logger.error(
                `${entry.kind} "${entry.name}" exists, but the record only claims it (a deploy was interrupted before confirming it), so nothing shows it is this preview's: it was left alone. If it is, delete it by hand, then run \`lunora preview delete\` again`,
            );

            return false;
        }

        const state = await recordedResourceState(request, entry);

        if (state === "changed") {
            logger.error(`${entry.kind} "${entry.name}" (${entry.id}): the recorded id now names a different resource, so it was left alone`);

            return false;
        }

        if (state === "present") {
            await deleteResource(request, entry);
            logger.success(`deleted ${entry.kind} "${entry.name}"`);
        }

        return true;
    } catch (error) {
        logger.error(`deleting ${entry.kind} "${entry.name}" failed (${reason(error)}); it stays on record for the next \`lunora preview delete\``);

        return false;
    }
};

/**
 * Delete the Worker, then each recorded resource; what could not be deleted stays on record for the next run,
 * and the record goes once nothing is left.
 */
const removePreview = async (
    request: Request,
    namespace: string,
    record: PreviewRecord,
    planned: PreviewPlan | undefined,
    logger: Logger,
    check: () => void,
    verify: () => Promise<void>,
): Promise<PreviewCommandResult> => {
    try {
        check();

        const worker = await workerMarker(request, record.worker, PREVIEW_MARKER_VAR);

        // A Worker by that name without this preview's marker was not deployed by it: deleting it would destroy someone else's.
        if (worker.exists && worker.marker !== previewMarker({ production: record.production, slug: record.name })) {
            return fail(logger, `Worker "${record.worker}" was not deployed as preview "${record.name}"; refusing to delete anything`);
        }

        // The Worker first: a resource must not disappear from under a Worker still serving it.
        if (worker.exists) {
            await deleteWorker(request, record.worker);
            logger.success(`deleted Worker "${record.worker}"`);
        }
    } catch (error) {
        return fail(logger, `deleting Worker "${record.worker}" failed (${reason(error)}); its resources were left in place`, EXIT_CODE.FAILURE);
    }

    const remaining = [];

    for (const claimed of record.resources) {
        check();

        // eslint-disable-next-line no-await-in-loop -- one at a time keeps the log in record order
        if (!(await removeRecorded(request, claimed, logger))) {
            remaining.push(claimed);
        }
    }

    const left = { ...record, resources: remaining, updatedAt: new Date().toISOString() };
    let unrecorded: string[];

    try {
        // KV is eventually consistent: the record read here can predate a resource a deploy just made. Writing
        // this stale copy back would erase the newer one that lists it, so the record is then left untouched;
        // a re-run finds what was already deleted gone, which counts as deleted.
        unrecorded = await unrecordedResources(request, planned?.resources ?? [], record);

        if (unrecorded.length === 0) {
            // The deletes may have outlasted the hold: another run may own the record by now.
            await verify();
            await (remaining.length === 0 ? deleteRecord(request, namespace, record) : writeRecord(request, namespace, left));
        }
    } catch (error) {
        return fail(logger, `preview "${record.name}": ${reason(error)}`, EXIT_CODE.FAILURE);
    }

    if (unrecorded.length > 0) {
        return fail(
            logger,
            `${unrecorded.join(", ")} exist(s) under this preview's names but not in the record read (a deploy may have just recorded it); the record was left as it is — run \`lunora preview delete ${record.name}\` again. If that keeps failing, the resource was never recorded (a deploy stopped between creating and recording it): delete it by hand, then run delete once more`,
            EXIT_CODE.FAILURE,
        );
    }

    if (remaining.length > 0) {
        return { code: EXIT_CODE.FAILURE, data: { preview: summarize(left) }, error: `${String(remaining.length)} preview resource(s) could not be deleted` };
    }

    return { code: EXIT_CODE.SUCCESS, data: { deleted: summarize(record) } };
};

/**
 * Why a preview with no readable record may still exist: its Worker or a resource under its names is in the account. With
 * no record there is no way to know whether it was made with `--env`, so the top level and every environment are looked at.
 */
const leftBehind = async (request: Request, config: PreviewConfig, slug: string): Promise<string[]> => {
    const origins: { config: PreviewConfig; env?: string }[] = [{ config }];

    for (const envName of Object.keys(config.env ?? {})) {
        // A block a preview run wrote is not an environment of the app, and `environmentConfig` says so by refusing it.
        const origin = environmentConfig(config, envName);

        if (origin.config !== undefined) {
            origins.push({ config: origin.config, env: envName });
        }
    }

    const found = await Promise.all(
        origins.map(async (origin) => {
            const { names } = previewNames(origin.config, slug);
            const planned = planPreview(origin.config, slug, origin.env).plan?.resources ?? [];

            if (names === undefined) {
                return [];
            }

            const worker = await workerMarker(request, names.worker, PREVIEW_MARKER_VAR);
            const resources = await unrecordedResources(request, planned, undefined);

            return [
                ...(worker.exists && worker.marker === previewMarker(names) ? [`Worker "${names.worker}" exists`] : []),
                ...resources.map((resource) => `${resource} exists`),
            ];
        }),
    );

    return [...new Set(found.flat())];
};

/** The plan the record was made from, to find what a deploy left unrecorded: from the environment it recorded, if any. */
const plannedAs = (config: PreviewConfig, record: PreviewRecord): PreviewPlan | undefined => {
    const origin = record.sourceEnv === undefined ? { config } : environmentConfig(config, record.sourceEnv);

    return origin.config === undefined ? undefined : planPreview({ ...origin.config, name: record.production }, record.name, record.sourceEnv).plan;
};

const deleteRecorded = async (
    context: PreviewContext,
    options: PreviewCommandOptions,
    { hold, names, namespace, request }: { hold: Hold; names: PreviewNames; namespace: string | undefined; request: Request },
): Promise<PreviewCommandResult> => {
    const { config } = context;
    const { logger } = options;
    let record: PreviewRecord | undefined;

    try {
        record =
            namespace === undefined
                ? undefined
                : await recordFor(request, namespace, context.appId, names.production, names.slug, logger, options.dryRun !== true);

        if (namespace === undefined || record === undefined) {
            const remains = await leftBehind(request, config, names.slug);

            // KV is eventually consistent, and a checkout can carry a different app id than the one that deployed: an absent
            // record is "nothing to delete" only when nothing under the preview's names is left in the account.
            if (remains.length > 0) {
                return fail(
                    logger,
                    `no record of preview "${names.slug}" could be read, but ${remains.join(" and ")}; nothing was deleted. If a deploy just ran, its record may not have reached this location yet: run delete again. Otherwise delete from a checkout whose package.json has the lunora.appId that deployed it`,
                    EXIT_CODE.FAILURE,
                );
            }
        }
    } catch (error) {
        return fail(logger, `preview "${names.slug}": ${reason(error)}`, EXIT_CODE.FAILURE);
    }

    if (namespace === undefined || record === undefined) {
        return fail(logger, `no preview "${names.slug}" of "${names.production}" is on record; nothing was deleted`, EXIT_CODE.NOT_FOUND);
    }

    // The record is account data anyone with the token can edit: it is trusted only for what a preview could own.
    const collisions = productionCollisions(config, [record.worker, ...record.resources.flatMap((resource) => [resource.id, resource.name])]);

    // The id and `name` form the key the record is later deleted under, so both must be the ones read. The Worker
    // is the one `record.production` named at deploy time, which is not the current name once the app was renamed.
    if (
        record.worker !== previewWorkerName(record.production, record.name) ||
        record.appId !== context.appId ||
        record.name !== names.slug ||
        collisions.length > 0
    ) {
        return fail(
            logger,
            `the record for preview "${names.slug}" names ${collisions.length > 0 ? `production's ${collisions.join(", ")}` : `Worker "${record.worker}", which is not the Worker of this preview`}; refusing to delete anything`,
        );
    }

    let states: ("changed" | "missing" | "present")[];

    try {
        states = await Promise.all(record.resources.map(async (resource) => recordedResourceState(request, resource)));
    } catch (error) {
        return fail(logger, `preview "${names.slug}": ${reason(error)}`, EXIT_CODE.FAILURE);
    }

    const changed = record.resources.filter((_resource, index) => states[index] === "changed");

    // An id that now names a different resource means the record is stale or was edited: delete nothing.
    if (changed.length > 0) {
        return fail(
            logger,
            `the record for preview "${names.slug}" lists ${changed.map((resource) => `${resource.kind} ${resource.id}`).join(", ")}, which no longer name(s) the recorded resource; refusing to delete anything`,
        );
    }

    if (options.dryRun === true) {
        logger.info(`dry run: would delete Worker "${record.worker}" and its Durable Objects`);

        for (const resource of record.resources) {
            logger.info(`  ${resource.kind} "${resource.name}" (${resource.binding})`);
        }

        return { code: EXIT_CODE.SUCCESS, data: { plan: summarize(record) } };
    }

    return removePreview(
        request,
        namespace,
        record,
        plannedAs(config, record),
        logger,
        () => {
            checkHeld(hold, record.name);
        },
        hold.verify,
    );
};

const deletePreview = async (context: PreviewContext, options: PreviewCommandOptions, name: string): Promise<PreviewCommandResult> => {
    const { config } = context;
    const { logger } = options;
    const named = previewNames(config, name);

    if (named.error !== undefined) {
        return fail(logger, named.error);
    }

    const { names } = named;
    const account = accountConfig(config, options);

    if (account.error !== undefined) {
        return fail(logger, account.error, options.env === undefined ? EXIT_CODE.AUTH : EXIT_CODE.USAGE);
    }

    const access = accountRequest(options, account.config);

    if (access.error !== undefined) {
        return fail(logger, access.error, EXIT_CODE.AUTH);
    }

    const { request } = access;

    let namespace: string | undefined;

    try {
        namespace = await registryNamespace(request, false);
    } catch (error) {
        return fail(logger, `preview "${names.slug}": ${reason(error)}`, EXIT_CODE.FAILURE);
    }

    // A delete and a deploy of one preview never overlap: either could otherwise write back a record for what the other removed.
    if (context.appId === undefined || namespace === undefined || options.dryRun === true) {
        return deleteRecorded(context, options, { hold: { lost: false, verify: () => Promise.resolve() }, names, namespace, request });
    }

    const { appId } = context;
    let database: string;
    let token: string;

    try {
        database = await lockDatabase(request);

        const lease = await takeLease(request, database, appId, names.slug);

        if (lease.held !== undefined) {
            return fail(logger, heldMessage(names.slug, lease.held));
        }

        ({ token } = lease);
    } catch (error) {
        return fail(logger, `preview "${names.slug}": ${reason(error)}`, EXIT_CODE.FAILURE);
    }

    const hold: Hold = {
        lost: false,
        verify: async () => {
            if (!(await renewLease(request, database, appId, names.slug, token))) {
                hold.lost = true;
                throw new Error(`the hold on preview "${names.slug}" is no longer this run's, so its record was left as the other run has it`);
            }
        },
    };
    const stop = keepLease(request, database, appId, names.slug, token, () => {
        hold.lost = true;
    });
    const disarm = guardCleanup(async () => {
        stop();
        await releaseLease(request, database, appId, names.slug, token);
    });

    try {
        const result = await deleteRecorded(context, options, { hold, names, namespace, request });

        return hold.lost ? holdLost(logger, names.slug, result) : result;
    } catch (error) {
        return fail(logger, `preview "${names.slug}": ${reason(error)}`, EXIT_CODE.FAILURE);
    } finally {
        stop();
        await releaseLease(request, database, appId, names.slug, token);
        disarm();
    }
};

const listPreviews = async (context: PreviewContext, options: PreviewCommandOptions): Promise<PreviewCommandResult> => {
    const { config } = context;
    const { logger } = options;
    const production = typeof config.name === "string" ? config.name : "";
    const account = accountConfig(config, options);

    if (account.error !== undefined) {
        return fail(logger, account.error, options.env === undefined ? EXIT_CODE.AUTH : EXIT_CODE.USAGE);
    }

    const access = accountRequest(options, account.config);

    if (access.error !== undefined) {
        return fail(logger, access.error, EXIT_CODE.AUTH);
    }

    let records: PreviewRecord[];

    try {
        const namespace = await registryNamespace(access.request, false);
        const none = { records: [], unreadable: [] };
        const listed = namespace === undefined || context.appId === undefined ? none : await listRecords(access.request, namespace, context.appId);
        // Previews made before projects had an id sit under the Worker name; `deploy` or `delete` of each re-keys it.
        const legacy = namespace === undefined ? none : await listRecords(access.request, namespace, production);

        records = [...listed.records, ...legacy.records];

        if (legacy.records.length > 0) {
            logger.warn(
                `${String(legacy.records.length)} preview(s) are recorded under the Worker name, from before projects had an id: ${legacy.records.map((record) => record.name).join(", ")}. ${context.appId === undefined ? "Add an app id to package.json, then run" : "Run"} \`lunora preview delete <name>\` (or deploy it again) to re-key each`,
            );
        }

        for (const key of [...listed.unreadable, ...legacy.unreadable]) {
            logger.warn(`the registry key "${key}" is not a preview record this CLI wrote; it is not listed, and \`delete\` will refuse it`);
        }
    } catch (error) {
        return fail(logger, reason(error), EXIT_CODE.FAILURE);
    }

    if (records.length === 0) {
        logger.info(`no previews of "${production}" are on record`);
    }

    for (const record of records) {
        logger.info(
            `${record.name}  ${record.url ?? "(not deployed)"}  Worker ${record.worker}, ${String(record.resources.length)} resource(s), updated ${record.updatedAt}`,
        );
    }

    return { code: EXIT_CODE.SUCCESS, data: { previews: records.map((record) => summarize(record)) } };
};

const runPreviewCommand = async (options: PreviewCommandOptions): Promise<PreviewCommandResult> => {
    const { logger, subcommand } = options;

    if (!PREVIEW_SUBCOMMANDS.includes(subcommand as (typeof PREVIEW_SUBCOMMANDS)[number])) {
        return fail(logger, `usage: lunora preview <${PREVIEW_SUBCOMMANDS.join(" | ")}> [name]`);
    }

    const loaded = loadContext(options);

    if (loaded.error !== undefined) {
        return fail(logger, loaded.error);
    }

    if (subcommand === "list") {
        return listPreviews(loaded.context, options);
    }

    if (options.name === undefined || options.name === "") {
        return fail(logger, `usage: lunora preview ${subcommand ?? ""} <name> — e.g. the pull request number`);
    }

    return subcommand === "deploy" ? deployPreview(loaded.context, options, options.name) : deletePreview(loaded.context, options, options.name);
};

/** `lunora preview` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<PreviewOptions> = defineHandler<PreviewOptions, PreviewCommandData>(async ({ argument, cwd, format, logger, options }) => {
    const result = await runPreviewCommand({
        cwd,
        dryRun: options.dryRun === true,
        env: options.env,
        format,
        logger,
        name: argument[1],
        secrets: options.secret ?? [],
        seed: options.seed === true,
        subcommand: argument[0],
        target: options.target,
        vars: options.var,
    });

    return { code: result.code, data: result.data, error: result.error };
});

export type { PreviewCommandOptions, PreviewCommandResult };
export { execute, runPreviewCommand };
