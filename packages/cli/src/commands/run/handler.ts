import { LunoraError } from "@lunora/errors";

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
    cwd?: string;
    fetchImpl?: FetchLike;
    functionPath: string;
    logger: Logger;
    shard?: string;
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

const runRpcCommand = async (options: RunCommandOptions): Promise<RunCommandResult> => {
    // Precedence: explicit `--url` > `.lunora/project.json` link > localhost dev worker.
    const resolvedUrl = resolveWorkerUrl({ cwd: options.cwd ?? process.cwd(), url: options.url });
    const baseUrl = (resolvedUrl ?? "http://localhost:8787").replace(TRAILING_SLASH, "");
    const requestUrl = `${baseUrl}/_lunora/rpc`;

    const fetchImpl: FetchLike = options.fetchImpl ?? (globalThis as unknown as { fetch: FetchLike }).fetch;

    if (typeof fetchImpl !== "function") {
        throw new TypeError("no fetch implementation available — pass --fetch via dependency injection or run on Node >= 18");
    }

    let parsedArgs: unknown;

    try {
        parsedArgs = parseArgsJson(options.args);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        options.logger.error(message);

        return { body: undefined, code: 1, requestUrl };
    }

    const payload: Record<string, unknown> = {
        args: parsedArgs,
        functionPath: options.functionPath,
    };

    if (options.shard !== undefined) {
        payload.shardKey = options.shard;
    }

    options.logger.info(`POST ${requestUrl} -> ${options.functionPath}`);

    const response = await fetchImpl(requestUrl, {
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
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

    return runRpcCommand({ args: options.args, cwd, functionPath, logger, shard: options.shard, url: options.url });
});

export { execute };
export type { FetchLike, RunCommandOptions, RunCommandResult };
export { runRpcCommand };
