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
import { createHash } from "node:crypto";
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

const POSTGRES_PORT = 5432;
const MYSQL_PORT = 3306;

/** The slice of a hand-written `wrangler.jsonc` this reads; every field is untrusted. */
interface HyperdriveWrangler {
    account_id?: unknown;
    env?: Record<string, { account_id?: unknown; hyperdrive?: unknown; name?: unknown } | undefined>;
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

/** Characters of the hash that closes a shortened name, with its dash. */
const HASH_SUFFIX = 7;

/**
 * The config name for a binding: the deployed Worker's name and the binding, in Cloudflare's alphabet.
 * Past the 32-character limit the front is cut and a short hash of the whole identity closes it, so two
 * long names that share a prefix still get names of their own.
 */
const configName = (workerName: string, binding: string): string => {
    const identity = `${workerName}-${binding}`.toLowerCase().replaceAll(NON_NAME_CHARACTER, "-");

    if (identity.length <= NAME_LIMIT) {
        return identity;
    }

    const hash = createHash("sha256")
        .update(identity)
        .digest("hex")
        .slice(0, HASH_SUFFIX - 1);

    return `${identity.slice(0, NAME_LIMIT - HASH_SUFFIX).replace(TRAILING_DASH, "")}-${hash}`;
};

const defaultPort = (scheme: string): number => (scheme === "mysql" ? MYSQL_PORT : POSTGRES_PORT);

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
        port: url.port === "" ? defaultPort(scheme) : Number(url.port),
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

/** What Cloudflare said went wrong, from its error envelope, without echoing the request. */
const describeFailure = (outcome: { status: number; text: string }): string => {
    let reasons = "";

    try {
        const { errors } = JSON.parse(outcome.text) as { errors?: { message?: unknown }[] };

        reasons = (errors ?? [])
            .flatMap((error) => (typeof error.message === "string" ? [error.message] : []))
            .slice(0, 2)
            .join("; ");
    } catch {
        // Not JSON (a gateway page): the status is all there is.
    }

    return reasons === "" ? `HTTP ${String(outcome.status)}` : `HTTP ${String(outcome.status)}: ${reasons}`;
};

/** A listed origin field as text, or `undefined` when the listing leaves it out. */
const asText = (value: unknown): string | undefined => (typeof value === "string" || typeof value === "number" ? value.toString() : undefined);

/** The fields of an existing config's origin that say which database it reaches. */
const ORIGIN_IDENTITY = ["host", "port", "database", "user"] as const;

/**
 * The id of the config called `name`, creating it when there is none. A config of that name that
 * reaches another database is not reused: its id would point the binding at the wrong one.
 * Throws on an API failure or a mismatch.
 */
const configId = async (request: Request, name: string, origin: Record<string, number | string>): Promise<{ id: string; reused: boolean }> => {
    const listed = await request("/hyperdrive/configs");

    if (!listed.ok) {
        throw new Error(`listing Hyperdrive configs failed (${describeFailure(listed)})`);
    }

    const configs = Array.isArray(listed.body.result) ? (listed.body.result as { id?: unknown; name?: unknown; origin?: Record<string, unknown> }[]) : [];
    const existing = configs.find((entry) => entry.name === name);

    if (typeof existing?.id === "string") {
        // Fields the listing leaves out cannot disagree; the password is never listed.
        const differs = ORIGIN_IDENTITY.filter((field) => {
            const listedValue = asText(existing.origin?.[field]);

            return listedValue !== undefined && listedValue !== asText(origin[field]);
        });

        if (differs.length > 0) {
            throw new Error(
                `a Hyperdrive config named "${name}" already exists for a different origin (${differs.join(", ")} differ). Delete it, or rename the Worker, so the binding does not reach the wrong database.`,
            );
        }

        return { id: existing.id, reused: true };
    }

    const created = await request("/hyperdrive/configs", { body: JSON.stringify({ name, origin }), method: "POST" });

    if (!created.ok) {
        throw new Error(`creating it failed (${describeFailure(created)})`);
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
    workerName: string;
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

/** What `wrangler.jsonc` holds for Hyperdrive in the environment being deployed. */
interface PlaceholderScan {
    accountId: unknown;
    entries: { binding: string; index: number }[];
    /** The JSON path of the array the entries sit in. */
    path: string[];
    /** The name the Worker is deployed under, which the config names are built from. */
    workerName: string;
    wranglerPath: string;
}

/** The Worker's deployed name: an environment's own `name`, else wrangler's `<name>-<env>`. */
const deployedName = (parsed: HyperdriveWrangler, wranglerEnvironment: string | undefined): string => {
    const base = typeof parsed.name === "string" && parsed.name !== "" ? parsed.name : "lunora";

    if (wranglerEnvironment === undefined) {
        return base;
    }

    const own = parsed.env?.[wranglerEnvironment]?.name;

    return typeof own === "string" && own !== "" ? own : `${base}-${wranglerEnvironment}`;
};

const scanPlaceholders = (cwd: string, wranglerEnvironment: string | undefined): PlaceholderScan | undefined => {
    const wranglerPath = findWranglerFile(cwd);
    const parsed = wranglerPath === undefined ? undefined : readWranglerJsonc<HyperdriveWrangler>(wranglerPath).parsed;

    if (wranglerPath === undefined || parsed === undefined) {
        return undefined;
    }

    // `hyperdrive` does not inherit into an environment: a named deploy reads and writes only that
    // block's array. A top-level placeholder is not what the environment's Worker is deployed with.
    const scope = wranglerEnvironment === undefined ? undefined : parsed.env?.[wranglerEnvironment];
    const entries = placeholderEntries(wranglerEnvironment === undefined ? parsed.hyperdrive : scope?.hyperdrive);

    return entries.length === 0
        ? undefined
        : {
              accountId: scope?.account_id ?? parsed.account_id,
              entries,
              path: wranglerEnvironment === undefined ? ["hyperdrive"] : ["env", wranglerEnvironment, "hyperdrive"],
              workerName: deployedName(parsed, wranglerEnvironment),
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
    const origins = entries.map(({ binding }) => {
        return { binding, origin: parseOrigin(environment[connectionStringVariable(binding)] ?? "") };
    });

    // Everything a binding needs is checked before the first API call, so a later binding's missing
    // connection string cannot leave an earlier one's config created and its id unrecorded.
    for (const { binding, origin } of origins) {
        const blocked = blocker(binding, origin, token !== undefined && accountId !== undefined);

        if (blocked !== undefined) {
            const message = `deploy blocked: ${blocked}`;

            options.logger.error(message);

            return message;
        }
    }

    for (const [position, { binding, index }] of entries.entries()) {
        const origin = origins[position]?.origin;

        if (origin === undefined || token === undefined || accountId === undefined) {
            continue;
        }

        try {
            // Written after each binding: a config that exists in the account is recorded at once.
            // eslint-disable-next-line no-await-in-loop -- one config at a time keeps the log in binding order
            const text = await setUpBinding(
                { accountId, binding, fetch: options.fetch, index, logger: options.logger, origin, path, token, workerName: scan.workerName, wranglerPath },
                readFileSync(wranglerPath, "utf8"),
            );

            writeFileSync(wranglerPath, text, "utf8");
        } catch (error) {
            const message = `deploy blocked: the "${binding}" Hyperdrive config could not be set up: ${error instanceof Error ? error.message : String(error)}`;

            options.logger.error(message);

            return message;
        }
    }

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
