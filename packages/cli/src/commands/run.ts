import type { Logger } from "../util/logger.js";

export type FetchLike = (input: string, init?: { body?: string; headers?: Record<string, string>; method?: string }) => Promise<{
    json: () => Promise<unknown>;
    ok: boolean;
    status: number;
    text: () => Promise<string>;
}>;

export interface RunCommandOptions {
    args?: string;
    cwd?: string;
    fetchImpl?: FetchLike;
    functionPath: string;
    logger: Logger;
    shard?: string;
    url?: string;
}

export interface RunCommandResult {
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

        throw new Error(`failed to parse --args as JSON: ${message}`);
    }
};

export const runRpcCommand = async (options: RunCommandOptions): Promise<RunCommandResult> => {
    const baseUrl = (options.url ?? "http://localhost:8787").replace(/\/$/u, "");
    const requestUrl = `${baseUrl}/_cirrus/rpc`;

    const fetchImpl: FetchLike = options.fetchImpl ?? ((globalThis as unknown as { fetch: FetchLike }).fetch);

    if (typeof fetchImpl !== "function") {
        throw new Error("no fetch implementation available — pass --fetch via dependency injection or run on Node >= 18");
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

    let body: unknown;

    try {
        body = await response.json();
    } catch {
        body = await response.text();
    }

    options.logger.info(JSON.stringify(body, undefined, 2));

    return {
        body,
        code: response.ok ? 0 : 1,
        requestUrl,
    };
};
