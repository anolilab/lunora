import { LunoraError } from "@lunora/errors";

import { describeAdminTokenSource, resolveAdminBearer } from "../../util/admin-token";
import { resolveAdminBaseUrl, resolveDefaultAdminUrl } from "../../util/admin-url";
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

const parseArgsJson = (raw: string | undefined, flag = "--args"): unknown => {
    if (raw === undefined || raw.length === 0) {
        return {};
    }

    try {
        return JSON.parse(raw);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        throw new LunoraError("INTERNAL", `failed to parse ${flag} as JSON: ${message}`, { cause: error });
    }
};

const TRAILING_SLASH = /\/$/u;

/** The admin op that dispatches a function under a forged identity. */
const RUN_AS_PATH = "__lunora_admin__:runAs";

/** Reserved admin function prefix — these carry the admin bearer rather than a user session. */
const ADMIN_PREFIX = "__lunora_admin__:";

/**
 * A shard denial on a plain call is almost always "this app gates on identity
 * and the CLI brought none" — say so, rather than leaving the operator to work
 * out from a bare 403 that `runAs` exists.
 */
const hintOnShardDenial = (logger: Logger, outcome: { body: unknown; runAs: boolean; status: number }): void => {
    // Read the code off the PARSED body, not the raw text: a substring match would
    // also fire on any response that merely quotes the code (an error message, a
    // log echo) and would stop firing the day the wire format is re-cased.
    const code = (outcome.body as { error?: { code?: unknown } } | undefined)?.error?.code;

    if (outcome.runAs || outcome.status !== 403 || code !== "FORBIDDEN_SHARD") {
        return;
    }

    logger.info("this app authorizes per shard, so an anonymous call is denied — retry with --as <userId> to run as an authenticated user");
};

/**
 * The `/rpc` envelope: either the call itself, or that call nested inside the
 * admin-gated `runAs` op.
 *
 * `--as` cannot be a plain RPC. A plain RPC arrives with no session, so any app
 * that configures `authorizeShard` — the recommended posture — default-denies it.
 * `runAs` forges the named identity for one dispatch, which is what the Studio's
 * "run as identity" tool does; the runtime exempts single-shard admin envelopes
 * from the tenant gate so the call reaches the DO's own bearer check.
 */
const buildEnvelope = ({
    args,
    claims,
    options,
    runAs,
}: {
    args: unknown;
    claims: Record<string, unknown> | undefined;
    options: RunCommandOptions;
    runAs: boolean;
}): Record<string, unknown> => {
    const envelope: Record<string, unknown> = runAs
        ? { args: { args, functionPath: options.functionPath, identity: claims, userId: options.as }, functionPath: RUN_AS_PATH }
        : { args, functionPath: options.functionPath };

    if (options.shard !== undefined) {
        envelope.shardKey = options.shard;
    }

    return envelope;
};

/**
 * Where this call goes — which depends on whether it carries a credential.
 *
 * WITHOUT a bearer: the documented `run` behaviour. `--url`, else the
 * `lunora link` target, else the running dev worker, else wrangler's port.
 *
 * WITH a bearer the link is deliberately NOT consulted. `resolveWorkerUrl` has no
 * `--prod` gate, so a linked production worker would otherwise become the silent
 * target of a forged-identity mutation — no flag, no confirmation.
 * `resolveAdminBaseUrl` then applies the gate every other bearer-carrying command
 * already uses: it refuses to put a full-access admin bearer on the wire in
 * cleartext to a non-loopback host.
 *
 * Returns `undefined` (after logging) when the target is unusable.
 */
const resolveRunTarget = ({ cwd, logger, needsBearer, url }: { cwd: string; logger: Logger; needsBearer: boolean; url?: string }): string | undefined => {
    if (needsBearer) {
        return resolveAdminBaseUrl(url, logger, cwd);
    }

    return (resolveWorkerUrl({ cwd, url }) ?? resolveDefaultAdminUrl(cwd)).replace(TRAILING_SLASH, "");
};

const runRpcCommand = async (options: RunCommandOptions): Promise<RunCommandResult> => {
    const cwd = options.cwd ?? process.cwd();
    const runAs = options.as !== undefined && options.as !== "";
    // A forged identity and the reserved admin paths both travel with the
    // full-access admin bearer, which changes how the target may be chosen.
    const needsBearer = runAs || options.functionPath.startsWith(ADMIN_PREFIX);

    const baseUrl = resolveRunTarget({ cwd, logger: options.logger, needsBearer, url: options.url });

    if (baseUrl === undefined) {
        return { body: undefined, code: 1, requestUrl: options.url ?? "" };
    }

    const requestUrl = `${baseUrl}/_lunora/rpc`;

    const fetchImpl: FetchLike = options.fetchImpl ?? (globalThis as unknown as { fetch: FetchLike }).fetch;

    if (typeof fetchImpl !== "function") {
        throw new TypeError("no fetch implementation available — pass --fetch via dependency injection or run on Node >= 18");
    }

    let parsedArgs: unknown;
    let parsedClaims: Record<string, unknown> | undefined;

    try {
        parsedArgs = parseArgsJson(options.args);
        parsedClaims = options.claims === undefined ? undefined : (parseArgsJson(options.claims, "--claims") as Record<string, unknown>);
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
    const { source, token } = needsBearer ? resolveAdminBearer({ cwd, token: options.token, url: baseUrl }) : {};

    if (needsBearer && token === undefined) {
        options.logger.error("admin token required — pass --token, set LUNORA_ADMIN_TOKEN, or add it to .dev.vars (local targets only)");

        return { body: undefined, code: 1, requestUrl };
    }

    if (token !== undefined) {
        options.logger.debug?.(`admin bearer from ${describeAdminTokenSource(source)}`);
    }

    const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    };

    const payload = buildEnvelope({ args: parsedArgs, claims: parsedClaims, options, runAs });

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

    hintOnShardDenial(options.logger, { body, runAs, status: response.status });

    return {
        body,
        code: response.ok ? 0 : 1,
        requestUrl,
    };
};

/** `lunora run <functionPath>` handler (lazy-loaded via the command's `loader`). */
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
