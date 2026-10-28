/**
 * `lunora preview deploy | list | delete` — an isolated copy of the app per pull request.
 *
 * A preview is its own Worker (so its own Durable Object namespace) with its own D1 databases, KV namespaces
 * and R2 buckets, deployed through the normal deploy pipeline under a transient `env.<preview>` block that is
 * written into `wrangler.jsonc` for the run and restored afterwards. What it owns is kept in an account-side
 * record (see `./registry`), which is all `delete` acts on.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import type { PreviewConfig, PreviewPlan, ResourceIds } from "./plan";
import { planPreview, previewEnvironmentBlock, previewNames, productionCollisions, resourceKey } from "./plan";
import type { PreviewRecord, Request } from "./registry";
import {
    createResource,
    deleteRecord,
    deleteResource,
    deleteWorker,
    findResource,
    listRecords,
    readRecord,
    recordKey,
    registryNamespace,
    workersSubdomain,
    writeRecord,
} from "./registry";

const PREVIEW_SUBCOMMANDS = ["deploy", "list", "delete"] as const;

const REQUEST_TIMEOUT_MS = 15_000;

const ADMIN_TOKEN_KEY = "LUNORA_ADMIN_TOKEN";

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

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The secrets the preview deploys with: a fresh value for every key Lunora can mint (the admin token always,
 * so this run can migrate and seed), and the value from the environment for each `--secret` the user named.
 * Production's values are never read: Cloudflare cannot return them, and a preview must not hold them unasked.
 */
const previewSecrets = async (
    cwd: string,
    options: PreviewCommandOptions,
): Promise<{ adminToken: string; error?: never; missing: string[]; values: Record<string, string> } | { error: string }> => {
    const environment = options.environment ?? process.env;
    const values: Record<string, string> = {};

    for (const key of options.secrets ?? []) {
        const value = environment[key];

        if (value === undefined || value === "") {
            return { error: `--secret ${key}: ${key} is not set in the environment, so there is no value to give the preview` };
        }

        values[key] = value;
    }

    const { fromLocal, fromPackages, mintableKeys } = await resolveRequiredSecretKeys(cwd, undefined);

    for (const key of [...fromPackages, ADMIN_TOKEN_KEY]) {
        if (values[key] === undefined && (mintableKeys.has(key) || key === ADMIN_TOKEN_KEY)) {
            values[key] = generateSecretValue();
        }
    }

    const missing = [...new Set([...fromPackages, ...fromLocal])].filter((key) => values[key] === undefined);

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
const shipPreview = async (context: PreviewContext, plan: PreviewPlan, options: PreviewCommandOptions, request: Request): Promise<PreviewCommandResult> => {
    const { config, cwd, wranglerPath } = context;
    const { logger } = options;
    const secrets = await previewSecrets(cwd, options);

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
        namespace = (await registryNamespace(request, true)) ?? "";

        const now = new Date().toISOString();
        const existing = await readRecord(request, namespace, recordKey(plan.production, plan.slug));

        if (existing !== undefined && existing.worker !== plan.worker) {
            return fail(logger, `the record for preview "${plan.slug}" names Worker "${existing.worker}", not "${plan.worker}"; refusing to deploy over it`);
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

    writeFileSync(wranglerPath, applyModify(text, ["env", plan.environment], previewEnvironmentBlock(config, plan, ids)), "utf8");

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
    // The preview's env block, and whatever reconcile adds to the top level, exist only for this run.
    const restore = snapshotPreviewConfig(cwd);

    try {
        // Bindings do not inherit into an environment: reconcile the top level first, so the env block copies
        // every binding the code needs, not the ones the last deploy happened to write.
        await provisionBindings(cwd, logger, undefined, "cloudflare", undefined);

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

            reportPlan(logger, plan, previewEnvironmentBlock(config, plan, ids));

            return { code: EXIT_CODE.SUCCESS, data: { plan: planSummary(plan) } };
        }

        const access = accountRequest(options, config);

        if (access.error !== undefined) {
            return fail(logger, access.error, EXIT_CODE.AUTH);
        }

        return await shipPreview({ ...context, config }, plan, options, access.request);
    } finally {
        restore();
    }
};

/**
 * Delete the Worker, then each recorded resource; what could not be deleted stays on record for the next run,
 * and the record goes once nothing is left.
 */
const removePreview = async (request: Request, namespace: string, record: PreviewRecord, logger: Logger): Promise<PreviewCommandResult> => {
    try {
        // The Worker first: a resource must not disappear from under a Worker still serving it.
        await deleteWorker(request, record.worker);
        logger.success(`deleted Worker "${record.worker}"`);
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

    try {
        await (remaining.length === 0 ? deleteRecord(request, namespace, record) : writeRecord(request, namespace, left));
    } catch (error) {
        return fail(logger, `preview "${record.name}": ${reason(error)}`, EXIT_CODE.FAILURE);
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

    if (options.dryRun === true) {
        logger.info(`dry run: would delete Worker "${record.worker}" and its Durable Objects`);

        for (const resource of record.resources) {
            logger.info(`  ${resource.kind} "${resource.name}" (${resource.binding})`);
        }

        return { code: EXIT_CODE.SUCCESS, data: { plan: summarize(record) } };
    }

    return removePreview(request, namespace, record, logger);
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

        records = namespace === undefined ? [] : await listRecords(access.request, namespace, production);
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
    });

    return { code: result.code, data: result.data, error: result.error };
});

export type { PreviewCommandOptions, PreviewCommandResult };
export { execute, runPreviewCommand };
