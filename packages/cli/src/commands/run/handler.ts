import { LunoraError } from "@lunora/errors";

import { describeAdminTokenSource, resolveAdminToken } from "../../util/admin-token";
import { resolveDefaultAdminUrl } from "../../util/admin-url";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import { resolveWorkerUrl } from "../../util/resolve-target";
import type { RunRpcOptions } from "./index";

type FetchLike = (
    input: string,
    init?: { body?: string; headers?: Record<string, string>; method?: string },
) => Promise<{
    json: () => Promise<unknown>;
    ok: boolean;
    status: number;
    text: () => Promise<string>;
}>;

interface RunCommandOptions {
    args?: string;
    /** Forge this user id for the call (dispatches through the admin-gated `runAs` op). */
    as?: string;
    /** JSON-encoded extra identity claims to accompany {@link RunCommandOptions.as}. */
    claims?: string;
    cwd?: string;
    fetchImpl?: FetchLike;
    functionPath: string;
    logger: Logger;
    shard?: string;
    /** Admin bearer for the `runAs` dispatch; resolved from the environment / `.dev.vars` when absent. */
    token?: string;
    url?: string;
}

interface RunCommandResult {
    body: unknown;
    code: number;
    requestUrl: string;
}

const parseArgsJson = (raw: string | undefined): unknown => {
    if (raw === undefined || raw.length === 0) {
        return {};
    }

    try {
        return JSON.parse(raw);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        throw new LunoraError("INTERNAL", `failed to parse --args as JSON: ${message}`, { cause: error });
    }
};

const TRAILING_SLASH = /\/$/u;

/** The admin op that dispatches a function under a forged identity. */
const RUN_AS_PATH = "__lunora_admin__:runAs";

/** Reserved admin function prefix — these carry the admin bearer rather than a user session. */
const ADMIN_PREFIX = "__lunora_admin__:";

/**
 * Headers for the dispatch. The admin bearer rides along only for the calls that
 * need it — a forged-identity `runAs` and the reserved admin paths — so an
 * ordinary function call keeps sending nothing it does not have to.
 *
 * Returns `undefined` (after logging) when a bearer is required and none of the
 * sources has one, so the caller can exit non-zero.
 */
const buildRequestHeaders = (options: RunCommandOptions, context: { baseUrl: string; cwd: string; runAs: boolean }): Record<string, string> | undefined => {
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (!context.runAs && !options.functionPath.startsWith(ADMIN_PREFIX)) {
        return headers;
    }

    const { source, token } = resolveAdminToken({ cwd: context.cwd, token: options.token, url: context.baseUrl });

    if (token === undefined) {
        options.logger.error("admin token required — pass --token, set LUNORA_ADMIN_TOKEN, or add it to .dev.vars (local targets only)");

        return undefined;
    }

    options.logger.debug?.(`admin bearer from ${describeAdminTokenSource(source)}`);

    return { ...headers, authorization: `Bearer ${token}` };
};

/**
 * A shard denial on a plain call is almost always "this app gates on identity
 * and the CLI brought none" — say so, rather than leaving the operator to work
 * out from a bare 403 that `runAs` exists.
 */
const hintOnShardDenial = (logger: Logger, outcome: { body: string; runAs: boolean; status: number }): void => {
    if (outcome.runAs || outcome.status !== 403 || !outcome.body.includes("FORBIDDEN_SHARD")) {
        return;
    }

    logger.info("this app authorizes per shard, so an anonymous call is denied — retry with --as <userId> to run as an authenticated user");
};

const runRpcCommand = async (options: RunCommandOptions): Promise<RunCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    // Precedence: explicit `--url` > `.lunora/project.json` link > the running dev
    // server's recorded URL > wrangler's default port.
    const resolvedUrl = resolveWorkerUrl({ cwd, url: options.url });
    const baseUrl = (resolvedUrl ?? resolveDefaultAdminUrl(cwd)).replace(TRAILING_SLASH, "");
    const requestUrl = `${baseUrl}/_lunora/rpc`;

    const fetchImpl: FetchLike = options.fetchImpl ?? (globalThis as unknown as { fetch: FetchLike }).fetch;

    if (typeof fetchImpl !== "function") {
        throw new TypeError("no fetch implementation available — pass --fetch via dependency injection or run on Node >= 18");
    }

    let parsedArgs: unknown;
    let parsedClaims: Record<string, unknown> | undefined;

    try {
        parsedArgs = parseArgsJson(options.args);
        parsedClaims = options.claims === undefined ? undefined : (parseArgsJson(options.claims) as Record<string, unknown>);
    } catch (error: unknown) {
        options.logger.error(error instanceof Error ? error.message : String(error));

        return { body: undefined, code: 1, requestUrl };
    }

    // `--as` dispatches through the admin-gated `runAs` op rather than calling the
    // function directly. A plain RPC arrives with no session, so ANY app that
    // configures `authorizeShard` — the recommended posture — default-denies it;
    // `runAs` forges the named identity for the dispatch, which is exactly what
    // the Studio's "run as identity" tool does, and the runtime already exempts
    // single-shard admin envelopes from the tenant gate so the call reaches the
    // DO's own bearer check.
    const runAs = options.as !== undefined && options.as !== "";
    const headers = buildRequestHeaders(options, { baseUrl, cwd, runAs });

    if (headers === undefined) {
        return { body: undefined, code: 1, requestUrl };
    }

    const payload: Record<string, unknown> = runAs
        ? {
              args: { args: parsedArgs, functionPath: options.functionPath, identity: parsedClaims, userId: options.as },
              functionPath: RUN_AS_PATH,
          }
        : { args: parsedArgs, functionPath: options.functionPath };

    if (options.shard !== undefined) {
        payload.shardKey = options.shard;
    }

    options.logger.info(`POST ${requestUrl} -> ${options.functionPath}${runAs ? ` (as ${options.as ?? ""})` : ""}`);

    const response = await fetchImpl(requestUrl, {
        body: JSON.stringify(payload),
        headers,
        method: "POST",
    });

    const text = await response.text();

    let body: unknown;

    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }

    options.logger.info(JSON.stringify(body, undefined, 2));

    hintOnShardDenial(options.logger, { body: text, runAs, status: response.status });

    return {
        body,
        code: response.ok ? 0 : 1,
        requestUrl,
    };
};

/** `lunora run &lt;functionPath>` handler (lazy-loaded via the command's `loader`). */
const execute: CommandHandler<RunRpcOptions> = defineHandler<RunRpcOptions>(({ argument, cwd, logger, options }) => {
    const functionPath = argument[0];

    if (!functionPath) {
        logger.error("missing function path. Usage: lunora run <functionPath> [--args <json>]");

        return { code: 1 };
    }

    return runRpcCommand({
        args: options.args,
        as: options.as,
        claims: options.claims,
        cwd,
        functionPath,
        logger,
        shard: options.shard,
        token: options.token,
        url: options.url,
    });
});

export { execute };
export type { FetchLike, RunCommandOptions, RunCommandResult };
export { runRpcCommand };
