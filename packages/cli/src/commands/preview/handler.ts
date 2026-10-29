/**
 * `lunora preview deploy | list | delete` — an isolated copy of the app per pull request.
 *
 * A preview is its own Worker (so its own Durable Object namespace) with its own D1 databases, KV namespaces
 * and R2 buckets, deployed through the normal deploy pipeline under a transient `env.<preview>` block that is
 * written into `wrangler.jsonc` for the run and restored afterwards. What it owns is kept in an account-side
 * record (see `./registry`), which is all `delete` acts on.
 */
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readServiceBindings, SCHEMA_SNAPSHOT_FILENAME } from "@lunora/codegen";
import { generateSecretValue } from "@lunora/config";
import { applyModify, findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

import { cloudflareRestRequest } from "../../../../../shared/cloudflare-rest";
import type { CloudflareEnvironment } from "../../util/cloudflare-credentials";
import { resolveCloudflareCredentials } from "../../util/cloudflare-credentials";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import { resolveTargetOrError } from "../../util/deploy-target-resolve";
import { EXIT_CODE } from "../../util/exit-code";
import type { HealthFetch } from "../../util/health-probe";
import type { Logger } from "../../util/logger";
import type { OutputFormat } from "../../util/output-format";
import type { Spawner } from "../../util/spawn";
import snapshotPreviewConfig from "../../util/wrangler-snapshot";
import type { StreamingFetchLike } from "../data-transfer/shared";
import { provisionBindings, runDeployCommand } from "../deploy/handler";
import { resolveRequiredSecretKeys } from "../deploy/secrets";
import { runSeedCommand } from "../seed/handler";
import type { PreviewOptions } from "./index";
import type { PlannedResource, PreviewConfig, PreviewPlan, ResourceIds } from "./plan";
import { planPreview, PREVIEW_MARKER_VAR, previewEnvironmentBlock, previewMarker, previewNames, productionCollisions, resourceKey } from "./plan";
import type { PreviewRecord, Request } from "./registry";
import {
    createResource,
    deleteRecord,
    deleteResource,
    deleteWorker,
    findResource,
    listRecords,
    readRecord,
    recordedResourceState,
    recordKey,
    registryNamespace,
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

    return { context: { config, cwd, wranglerPath } };
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

/**
 * Give every planned resource its id: the recorded one, or a new resource, recorded the moment it exists.
 * A resource that already exists under a preview name but is not on record is never adopted: nothing shows
 * it is the preview's, and deleting the preview later would delete it.
 */
const ensureResources = async (request: Request, namespace: string, plan: PreviewPlan, record: PreviewRecord, logger: Logger): Promise<ResourceIds> => {
    const ids = new Map<string, string>();

    for (const planned of plan.resources) {
        const recorded = record.resources.find((resource) => resource.kind === planned.kind && resource.binding === planned.binding);

        if (recorded !== undefined) {
            // eslint-disable-next-line no-await-in-loop -- see below
            const state = await recordedResourceState(request, recorded);

            // A recorded id that no longer names the recorded resource is never bound: it may be anyone's now.
            if (state !== "present") {
                throw new Error(
                    `the record lists ${planned.kind} "${recorded.name}" (${recorded.id}), which is ${state === "missing" ? "gone" : "now a different resource"}; run \`lunora preview delete ${plan.slug}\`, then deploy again`,
                );
            }

            ids.set(resourceKey(planned.kind, planned.binding), recorded.id);
            logger.info(`reusing preview ${planned.kind} "${recorded.name}" for ${planned.binding}`);

            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- one resource at a time, each recorded before the next is made
        const existing = await findResource(request, planned.kind, planned.name);

        if (existing !== undefined) {
            throw new Error(
                `a ${planned.kind} resource named "${planned.name}" already exists but no preview record says this preview created it; refusing to bind or later delete it. Rename or remove it, then deploy again.`,
            );
        }

        // eslint-disable-next-line no-await-in-loop -- see above
        const id = await createResource(request, planned.kind, planned.name);

        record.resources.push({ binding: planned.binding, id, kind: planned.kind, name: planned.name });
        // eslint-disable-next-line no-await-in-loop -- recorded before anything else can fail, so delete can find it
        await writeRecord(request, namespace, record);
        ids.set(resourceKey(planned.kind, planned.binding), id);
        logger.success(`created preview ${planned.kind} "${planned.name}" for ${planned.binding}`);
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
            error: `the record for preview "${plan.slug}" names Worker "${existing.worker}", not "${plan.worker}"; refusing to deploy over it`,
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

    logger.info(`  env.${plan.environment}: ${JSON.stringify(block)}`);
};

/** Everything after the plan: record, resources, the env block, the deploy, then migrations (in the deploy) and the seed. */
const shipPreview = async (
    context: PreviewContext,
    plan: PreviewPlan,
    variables: Readonly<Record<string, string>>,
    options: PreviewCommandOptions,
    request: Request,
): Promise<PreviewCommandResult> => {
    const { config, cwd, wranglerPath } = context;
    const { logger } = options;
    const secrets = await previewSecrets(cwd, config, plan.worker, options);

    if (secrets.error !== undefined) {
        return fail(logger, secrets.error);
    }

    for (const key of secrets.missing) {
        logger.warn(`the preview has no ${key}: production's is never copied. Pass --secret ${key} with ${key} set in the environment to give it one.`);
    }

    let record: PreviewRecord;
    let ids: ResourceIds;
    let url: string;
    let namespace: string;

    try {
        // A Worker with the preview's name that this command did not deploy is someone else's: never deploy over it.
        const existingWorker = await workerMarker(request, plan.worker, PREVIEW_MARKER_VAR);

        if (existingWorker.exists && existingWorker.marker !== previewMarker(plan)) {
            return fail(logger, `a Worker named "${plan.worker}" already exists and was not deployed as preview "${plan.slug}"; refusing to deploy over it`);
        }

        namespace = (await registryNamespace(request, true)) ?? "";

        const now = new Date().toISOString();
        const existing = await readRecord(request, namespace, recordKey(plan.production, plan.slug));

        const refusal = await recordRefusal(request, plan, existing, existingWorker.exists);

        if (refusal !== undefined) {
            return fail(logger, refusal.error, refusal.code);
        }

        record = existing ?? {
            createdAt: now,
            environment: plan.environment,
            name: plan.slug,
            production: plan.production,
            resources: [],
            updatedAt: now,
            version: 1,
            worker: plan.worker,
        };
        await writeRecord(request, namespace, record);
        ids = await ensureResources(request, namespace, plan, record, logger);
        url = `https://${plan.worker}.${await workersSubdomain(request)}.workers.dev`;
    } catch (error) {
        return fail(logger, `preview "${plan.slug}": ${reason(error)}`, EXIT_CODE.FAILURE);
    }

    const collisions = productionCollisions(config, [...ids.values()]);

    if (collisions.length > 0) {
        return fail(logger, `preview "${plan.slug}" would bind production's ${collisions.join(", ")}; refusing to deploy`);
    }

    const text = readFileSync(wranglerPath, "utf8");

    writeFileSync(wranglerPath, applyModify(text, ["env", plan.environment], previewEnvironmentBlock(config, plan, ids, variables)), "utf8");

    const secretsFile = writeSecretsFile(secrets.values);

    try {
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

        record.url = deployed.deployment?.url ?? url;
        record.updatedAt = new Date().toISOString();
        await writeRecord(request, namespace, record);

        if (deployed.code !== 0) {
            return { code: deployed.code, data: { preview: summarize(record) }, error: deployed.error ?? `preview "${plan.slug}" did not deploy` };
        }
    } catch (error) {
        return fail(logger, `preview "${plan.slug}": ${reason(error)}`, EXIT_CODE.FAILURE);
    } finally {
        rmSync(secretsFile.directory, { force: true, recursive: true });
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

const deployPreview = async (context: PreviewContext, options: PreviewCommandOptions, name: string): Promise<PreviewCommandResult> => {
    const { cwd } = context;
    const { logger } = options;
    const parsed = parseVariables(options.vars ?? []);

    if (parsed.error !== undefined) {
        return fail(logger, parsed.error);
    }

    const { variables } = parsed;
    // The preview's env block, and whatever reconcile adds to the top level, exist only for this run.
    const restore = snapshotPreviewConfig(cwd);
    // Codegen writes a first schema baseline when there is none; the branch's schema must not become production's.
    const baselinePath = join(cwd, "lunora", SCHEMA_SNAPSHOT_FILENAME);
    const hadBaseline = existsSync(baselinePath);

    try {
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

        const config = readWranglerJsonc<PreviewConfig>(context.wranglerPath).parsed ?? context.config;
        const planned = planPreview(config, name);

        if (planned.error !== undefined) {
            return fail(logger, planned.error);
        }

        const { plan } = planned;
        const collisions = productionCollisions(config, [plan.worker, ...plan.resources.map((resource) => resource.name)]);

        if (collisions.length > 0) {
            return fail(logger, `preview "${plan.slug}" names collide with production's ${collisions.join(", ")}; name the preview differently`);
        }

        if (options.dryRun === true) {
            // Placeholder ids: a dry run makes no API call, so it shows the block's shape, not the account's ids.
            const ids = new Map(plan.resources.map((resource) => [resourceKey(resource.kind, resource.binding), `<${resource.name}>`]));

            reportPlan(logger, plan, previewEnvironmentBlock(config, plan, ids, variables));
            logger.info(
                `  secrets: every one Lunora can mint, fresh${(options.secrets ?? []).length > 0 ? `; from the environment: ${(options.secrets ?? []).join(", ")}` : ""}`,
            );

            return { code: EXIT_CODE.SUCCESS, data: { plan: planSummary(plan) } };
        }

        const access = accountRequest(options, config);

        if (access.error !== undefined) {
            return fail(logger, access.error, EXIT_CODE.AUTH);
        }

        return await shipPreview({ ...context, config }, plan, variables, options, access.request);
    } finally {
        restore();

        if (!hadBaseline) {
            rmSync(baselinePath, { force: true });
        }
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
): Promise<PreviewCommandResult> => {
    try {
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

    for (const resource of record.resources) {
        try {
            // eslint-disable-next-line no-await-in-loop -- one at a time keeps the log in record order
            await deleteResource(request, resource);
            logger.success(`deleted ${resource.kind} "${resource.name}"`);
        } catch (error) {
            logger.error(`deleting ${resource.kind} "${resource.name}" failed (${reason(error)}); it stays on record for the next \`lunora preview delete\``);
            remaining.push(resource);
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

const deletePreview = async (context: PreviewContext, options: PreviewCommandOptions, name: string): Promise<PreviewCommandResult> => {
    const { config } = context;
    const { logger } = options;
    const named = previewNames(config, name);

    if (named.error !== undefined) {
        return fail(logger, named.error);
    }

    const { names } = named;
    const access = accountRequest(options, config);

    if (access.error !== undefined) {
        return fail(logger, access.error, EXIT_CODE.AUTH);
    }

    const { request } = access;

    let namespace: string | undefined;
    let record: PreviewRecord | undefined;

    try {
        namespace = await registryNamespace(request, false);
        record = namespace === undefined ? undefined : await readRecord(request, namespace, recordKey(names.production, names.slug));
    } catch (error) {
        return fail(logger, `preview "${names.slug}": ${reason(error)}`, EXIT_CODE.FAILURE);
    }

    if (namespace === undefined || record === undefined) {
        return fail(logger, `no preview "${names.slug}" of "${names.production}" is on record; nothing was deleted`, EXIT_CODE.NOT_FOUND);
    }

    // The record is account data anyone with the token can edit: it is trusted only for what a preview could own.
    const collisions = productionCollisions(config, [record.worker, ...record.resources.flatMap((resource) => [resource.id, resource.name])]);

    if (record.worker !== names.worker || record.production !== names.production || collisions.length > 0) {
        return fail(
            logger,
            `the record for preview "${names.slug}" names ${collisions.length > 0 ? `production's ${collisions.join(", ")}` : `Worker "${record.worker}", not "${names.worker}"`}; refusing to delete anything`,
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

    return removePreview(request, namespace, record, planPreview(config, name).plan, logger);
};

const listPreviews = async (context: PreviewContext, options: PreviewCommandOptions): Promise<PreviewCommandResult> => {
    const { config } = context;
    const { logger } = options;
    const production = typeof config.name === "string" ? config.name : "";
    const access = accountRequest(options, config);

    if (access.error !== undefined) {
        return fail(logger, access.error, EXIT_CODE.AUTH);
    }

    let records: PreviewRecord[];

    try {
        const namespace = await registryNamespace(access.request, false);
        const listed = namespace === undefined ? { records: [], unreadable: [] } : await listRecords(access.request, namespace, production);

        records = listed.records;

        for (const key of listed.unreadable) {
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
