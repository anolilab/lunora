/**
 * Create the Hyperdrive config a binding needs, from a connection string.
 *
 * Reconcile writes `{ binding: "HYPERDRIVE", id: <placeholder> }` so dev works at
 * once (an embedded Postgres serves it). A deploy needs a real config, and
 * Hyperdrive has no wrangler auto-provisioning, so here the config is created
 * from the Postgres/MySQL connection string in `LUNORA_<BINDING>_URL` and its id
 * written back to `wrangler.jsonc`. A config of the same name is reused, so a
 * re-deploy (or a second machine) never creates a duplicate. The connection
 * string stays in the environment: it is sent to Cloudflare and never logged,
 * written, or put on a command line.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { applyModify, findWranglerFile, HYPERDRIVE_PLACEHOLDER_ID, readWranglerJsonc } from "@lunora/config/cloudflare";

import { cloudflareRestRequest } from "../../../../../shared/cloudflare-rest";
import type { CloudflareEnvironment } from "../../util/cloudflare-credentials";
import { resolveCloudflareCredentials } from "../../util/cloudflare-credentials";
import type { Logger } from "../../util/logger";
import type { PreDeployCommand } from "./checks";
import type { DeployCommandOptions } from "./types";

/** Cloudflare caps a Hyperdrive config's name at 32 characters. */
const NAME_LIMIT = 32;

const REQUEST_TIMEOUT_MS = 15_000;

/** The slice of a hand-written `wrangler.jsonc` this reads; every field is untrusted. */
interface HyperdriveWrangler {
    account_id?: unknown;
    env?: Record<string, { account_id?: unknown; hyperdrive?: unknown } | undefined>;
    hyperdrive?: unknown;
    name?: unknown;
}

interface ProvisionHyperdriveOptions {
    cwd: string;
    /** Defaults to `process.env`. */
    environment?: CloudflareEnvironment & Record<string, string | undefined>;
    fetch?: typeof globalThis.fetch;
    logger: Logger;
    /** The `--env` being deployed. */
    wranglerEnvironment?: string;
}

type Request = (path: string, init?: RequestInit) => ReturnType<typeof cloudflareRestRequest>;

const NON_NAME_CHARACTER = /[^a-z0-9-]/gu;
const NON_VARIABLE_CHARACTER = /[^A-Za-z0-9]/gu;
const TRAILING_DASH = /-$/u;

/** The environment variable a binding's connection string is read from. */
const connectionStringVariable = (binding: string): string => `LUNORA_${binding.replaceAll(NON_VARIABLE_CHARACTER, "_").toUpperCase()}_URL`;

/** The config name for a binding: the Worker's name and the binding, lowercased to Cloudflare's alphabet. */
const configName = (workerName: unknown, binding: string): string => {
    const worker = typeof workerName === "string" && workerName !== "" ? workerName : "lunora";

    return `${worker}-${binding}`.toLowerCase().replaceAll(NON_NAME_CHARACTER, "-").slice(0, NAME_LIMIT).replace(TRAILING_DASH, "");
};

/** The `origin` Cloudflare wants, from a `postgres://` or `mysql://` URL, or `undefined` when it is not one. */
const parseOrigin = (value: string): Record<string, number | string> | undefined => {
    let url: URL;

    try {
        url = new URL(value);
    } catch {
        return undefined;
    }

    const scheme = url.protocol.slice(0, -1);
    const database = decodeURIComponent(url.pathname.slice(1));

    if (!["mysql", "postgres", "postgresql"].includes(scheme) || url.hostname === "" || database === "") {
        return undefined;
    }

    return {
        database,
        host: url.hostname,
        password: decodeURIComponent(url.password),
        ...(url.port === "" ? {} : { port: Number(url.port) }),
        scheme,
        user: decodeURIComponent(url.username),
    };
};

/** The bindings still carrying the placeholder id, with their position in the array. */
const placeholderEntries = (hyperdrive: unknown): { binding: string; index: number }[] =>
    (Array.isArray(hyperdrive) ? (hyperdrive as unknown[]) : []).flatMap((entry, index) => {
        const { binding, id } = (typeof entry === "object" && entry !== null ? entry : {}) as { binding?: unknown; id?: unknown };

        return typeof binding === "string" && id === HYPERDRIVE_PLACEHOLDER_ID ? [{ binding, index }] : [];
    });

/** The id of the config called `name`, creating it when there is none. Throws on an API failure. */
const configId = async (request: Request, name: string, origin: Record<string, number | string>): Promise<{ id: string; reused: boolean }> => {
    const listed = await request("/hyperdrive/configs");

    if (!listed.ok) {
        throw new Error(`listing Hyperdrive configs failed (HTTP ${String(listed.status)})`);
    }

    const configs = Array.isArray(listed.body.result) ? (listed.body.result as { id?: unknown; name?: unknown }[]) : [];
    const existing = configs.find((entry) => entry.name === name)?.id;

    if (typeof existing === "string") {
        return { id: existing, reused: true };
    }

    const created = await request("/hyperdrive/configs", { body: JSON.stringify({ name, origin }), method: "POST" });

    if (!created.ok) {
        throw new Error(`creating it failed (HTTP ${String(created.status)})`);
    }

    const { id } = (typeof created.body.result === "object" && created.body.result !== null ? created.body.result : {}) as { id?: unknown };

    if (typeof id !== "string") {
        throw new TypeError("the response carried no id");
    }

    return { id, reused: false };
};

/** Why a binding cannot get its config yet, or `undefined` when it can. */
const blocker = (binding: string, origin: unknown, hasCredentials: boolean): string | undefined => {
    if (origin === undefined) {
        return `the "${binding}" Hyperdrive binding has no config yet. Set ${connectionStringVariable(binding)} to its postgres:// or mysql:// connection string and Lunora creates the config, or run \`wrangler hyperdrive create\` and put its id in wrangler.jsonc.`;
    }

    return hasCredentials
        ? undefined
        : `creating the "${binding}" Hyperdrive config needs CLOUDFLARE_API_TOKEN (Hyperdrive: Edit) and CLOUDFLARE_ACCOUNT_ID, or run \`wrangler hyperdrive create\` and put its id in wrangler.jsonc.`;
};

interface BindingSetup {
    accountId: string;
    binding: string;
    fetch?: typeof globalThis.fetch;
    index: number;
    logger: Logger;
    origin: Record<string, number | string>;
    /** The JSON path of the array holding the binding. */
    path: string[];
    token: string;
    workerName: unknown;
    wranglerPath: string;
}

/** Create (or reuse) one binding's config and return `wrangler.jsonc`'s text with its id in; throws on an API failure. */
const setUpBinding = async (setup: BindingSetup, text: string): Promise<string> => {
    const name = configName(setup.workerName, setup.binding);
    const { id, reused } = await configId(
        async (requestPath, init) =>
            cloudflareRestRequest({
                accountId: setup.accountId,
                apiToken: setup.token,
                ...(setup.fetch === undefined ? {} : { fetch: setup.fetch }),
                init: { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
                path: requestPath,
            }),
        name,
        setup.origin,
    );

    setup.logger.success(`${reused ? "reusing" : "created"} Hyperdrive config "${name}" for ${setup.binding} → ${setup.wranglerPath}`);

    return applyModify(text, [...setup.path, setup.index, "id"], id);
};

/**
 * Replace every placeholder Hyperdrive id in `wrangler.jsonc` with a real config's.
 * Returns the error that blocks the deploy, or `undefined` when nothing is left to do.
 */
/** What `wrangler.jsonc` holds for Hyperdrive in the environment being deployed. */
interface PlaceholderScan {
    accountId: unknown;
    entries: { binding: string; index: number }[];
    /** The JSON path of the array the entries sit in. */
    path: string[];
    workerName: unknown;
    wranglerPath: string;
}

const scanPlaceholders = (cwd: string, wranglerEnvironment: string | undefined): PlaceholderScan | undefined => {
    const wranglerPath = findWranglerFile(cwd);
    const parsed = wranglerPath === undefined ? undefined : readWranglerJsonc<HyperdriveWrangler>(wranglerPath).parsed;

    if (wranglerPath === undefined || parsed === undefined) {
        return undefined;
    }

    // `hyperdrive` does not inherit into an environment, so its own array is the one to read and write.
    const scope = wranglerEnvironment === undefined ? undefined : parsed.env?.[wranglerEnvironment];
    const entries = placeholderEntries(scope?.hyperdrive ?? parsed.hyperdrive);

    return entries.length === 0
        ? undefined
        : {
              accountId: scope?.account_id ?? parsed.account_id,
              entries,
              path: scope?.hyperdrive === undefined ? ["hyperdrive"] : ["env", wranglerEnvironment ?? "", "hyperdrive"],
              workerName: parsed.name,
              wranglerPath,
          };
};

/**
 * Replace every placeholder Hyperdrive id in `wrangler.jsonc` with a real config's.
 * Returns the error that blocks the deploy, or `undefined` when nothing is left to do.
 */
const provisionHyperdrive = async (options: ProvisionHyperdriveOptions): Promise<string | undefined> => {
    const scan = scanPlaceholders(options.cwd, options.wranglerEnvironment);

    if (scan === undefined) {
        return undefined;
    }

    const { entries, path, wranglerPath } = scan;
    const environment = options.environment ?? process.env;
    const { accountId, token } = resolveCloudflareCredentials(environment, scan.accountId);
    let text = readFileSync(wranglerPath, "utf8");

    for (const { binding, index } of entries) {
        const origin = parseOrigin(environment[connectionStringVariable(binding)] ?? "");
        const blocked = blocker(binding, origin, token !== undefined && accountId !== undefined);

        try {
            if (blocked !== undefined || origin === undefined || token === undefined || accountId === undefined) {
                throw new Error(blocked ?? "missing credentials");
            }

            // eslint-disable-next-line no-await-in-loop -- one config at a time keeps the log in binding order
            text = await setUpBinding(
                { accountId, binding, fetch: options.fetch, index, logger: options.logger, origin, path, token, workerName: scan.workerName, wranglerPath },
                text,
            );
        } catch (error) {
            const message = `deploy blocked: ${error instanceof Error ? error.message : String(error)}`;

            options.logger.error(message);

            return message;
        }
    }

    writeFileSync(wranglerPath, text, "utf8");

    return undefined;
};

/** `prepare` hands the artifacts to someone else's deployer, which would receive the placeholder; stop it. */
const blockPlaceholder = (cwd: string, options: Pick<DeployCommandOptions, "env" | "logger">): string | undefined => {
    const binding = scanPlaceholders(cwd, options.env)?.entries[0]?.binding;

    if (binding === undefined) {
        return undefined;
    }

    const message = `prepare blocked: the "${binding}" Hyperdrive binding still has its placeholder id. Run \`lunora deploy\` with ${connectionStringVariable(binding)} set to create the config, or put the id from \`wrangler hyperdrive create\` in wrangler.jsonc.`;

    options.logger.error(message);

    return message;
};

/**
 * The deploy pipeline's step. It creates account resources, so only a real Cloudflare
 * deploy creates them: a dry run must leave the account alone, and `prepare` (which
 * hands the artifacts to someone else's deployer) only refuses to pass the placeholder on.
 */
const provisionDeployHyperdrive = async (
    cwd: string,
    options: Pick<DeployCommandOptions, "dryRun" | "env" | "logger">,
    command: PreDeployCommand,
    target: string,
): Promise<string | undefined> => {
    if (target !== "cloudflare") {
        return undefined;
    }

    if (command === "prepare") {
        return blockPlaceholder(cwd, options);
    }

    return options.dryRun === true ? undefined : provisionHyperdrive({ cwd, logger: options.logger, wranglerEnvironment: options.env });
};

export type { ProvisionHyperdriveOptions };
export { connectionStringVariable, provisionDeployHyperdrive, provisionHyperdrive };
