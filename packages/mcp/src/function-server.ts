import type { FunctionReference } from "@lunora/client";
import { LunoraClient } from "@lunora/client";
// eslint-disable-next-line sonarjs/deprecation -- the low-level `Server` is the sanctioned choice here, as in `./server`: plain JSON Schema tools with no per-tool zod.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import pkg from "../package.json";
import { coerceArgs } from "./function-args";
import type { FunctionKind, FunctionRoute, FunctionTools } from "./function-tools";
import { functionToolsFromOpenRpc, isWrite } from "./function-tools";
import { errorFromThrown, errorResult, ok, okStructured } from "./tool-result";
import type { ToolResult } from "./tool-types";
import { readArgumentsBag } from "./tools";
import { readConfirmation, screenWriteConfirmation } from "./write-confirmation";

/**
 * Serve a developer's own Lunora app over MCP: one tool per query, mutation,
 * action and stream, each taking its arguments as a typed JSON Schema.
 *
 * Identity is the caller's, not an admin's. The `token` is the bearer the app
 * already uses for its own RPC calls, so auth and row-level security apply to
 * every tool call exactly as they do to the app. Nothing here calls an
 * `/_lunora/admin/*` route, so this server needs no admin token.
 *
 * The tool list comes from the `openRpcSpec` the app was generated with, so
 * `tools/list` makes no network call. That document exists only when the project
 * sets `apiSpec: "openrpc"` or `"both"`. It can be a resolver that re-reads the
 * document, and the tools then follow a rewrite of it while the server runs.
 */

const SERVER_NAME = "lunora";

interface FunctionMcpServerOptions {
    /**
     * Advertise and allow mutation and action tools. Off by default. A closed write
     * is not listed and is refused at dispatch.
     */
    allowWrites?: boolean;
    fetch?: typeof fetch;
    /** The MCP server name clients show. Defaults to `lunora`. */
    name?: string;

    /**
     * Told when a rewritten document cannot be read or built. The server keeps the tools it
     * last built, so the error is reported here rather than failing the request.
     */
    onReloadError?: (error: unknown) => void;

    /**
     * The `openRpcSpec` export of `_generated/openrpc`, or a function returning it. A
     * function is called on every `tools/list` and `tools/call`, so the tools follow a
     * document that codegen rewrites while the server runs. Return the same object
     * while the document is unchanged: a different object rebuilds the tools.
     */
    openRpcSpec: unknown;
    /** The CALLER's bearer. Writes need one: the confirmation digest is keyed by it. */
    token?: string;

    /**
     * The Lunora deployment URL the app talks to. A function is resolved on every
     * call, so a server started before `lunora dev` picks the URL up once it exists.
     * `undefined` means no deployment is running yet, and the call says so.
     */
    url: string | (() => string | undefined);
    version?: string;
}

const reference = (path: string): FunctionReference => {
    return { __lunoraRef: path };
};

/** An empty shard key is the unsharded default, so it is coerced to `undefined` rather than forwarded. */
const shardKeyOf = (input: Record<string, unknown>): string | undefined =>
    typeof input["shardKey"] === "string" && input["shardKey"].length > 0 ? input["shardKey"] : undefined;

/**
 * Shape a function's result for the wire. A declared object output is returned
 * as `structuredContent`, which the SDK checks against the `outputSchema`. A
 * non-object output is wrapped as `{ result }`, because MCP requires an object
 * root. The text block carries the same value either way.
 */
const resultOf = (route: FunctionRoute, value: unknown): ToolResult => {
    if (route.outputMode === "object") {
        // An optional output that returned `undefined` has no object to send, so it goes out as
        // the empty object the output schema admits. Any other value was validated by `applyOutput`.
        if (value === undefined) {
            return { ...ok(value), structuredContent: {} };
        }

        return okStructured(value as Record<string, unknown>);
    }

    if (route.outputMode === "wrapped") {
        return okStructured({ result: value });
    }

    return ok(value);
};

/**
 * The write half: the confirmation handshake, then the call. A proposal is
 * returned in place of the call until its digest is confirmed.
 *
 * The proposal carries the arguments as sent. A decoded bigint or ArrayBuffer
 * cannot be canonicalised into the digest, so decoding waits for the gate. The
 * carriers are still checked first, so a malformed value is refused before a
 * proposal is minted.
 */
const runWrite = async (
    client: LunoraClient,
    route: FunctionRoute,
    tool: string,
    input: Record<string, unknown>,
    rawArgs: Record<string, unknown>,
    shardKey: string | undefined,
): Promise<ToolResult> => {
    const kind: Extract<FunctionKind, "action" | "mutation"> = route.kind === "action" ? "action" : "mutation";

    coerceArgs(route.argsSchema, rawArgs);

    const confirmation = readConfirmation(input);
    const gate = await screenWriteConfirmation(
        client,
        { args: rawArgs, functionPath: route.path, idempotencyKey: confirmation.idempotencyKey, kind, shardKey, tool },
        confirmation,
        route.sensitiveArgs,
        // The function is named by the tool, so the second call resends only what the input carries.
        ["args", "shardKey", "idempotencyKey"],
    );

    if (gate !== undefined) {
        return gate;
    }

    const args = coerceArgs(route.argsSchema, rawArgs);
    // A sensitive argument travels on a sensitive reference, so the client never queues
    // the call offline. This mirrors the generic write path in `./tools`.
    const target = route.sensitiveArgs.length === 0 ? reference(route.path) : { __lunoraRef: route.path, sensitive: true as const };

    const value = kind === "action" ? await client.action(target, args, { shardKey }) : await client.mutation(target, args, { onlineOnly: true, shardKey });

    return resultOf(route, value);
};

/**
 * What a stream call gets from its MCP request. `signal` is the caller's abort, which
 * cancels the stream. `progress` is present only when the request carried a
 * `progressToken`, and it is sent once per chunk with that chunk's index.
 */
interface StreamCallContext {
    progress?: (chunkIndex: number) => Promise<void>;
    signal?: AbortSignal;
}

/**
 * The most chunks one stream call collects. Chunks are held in memory until the stream
 * completes, so an endless stream has to be cut off by count. Only the count is capped:
 * a stream of very large chunks, or a slow one, is not.
 */
const MAX_STREAM_CHUNKS = 10_000;

/**
 * The read half of a stream: open it, report each chunk as progress, and return every
 * chunk once it completes. A mid-stream error throws out of the loop, and the caller's
 * `try` turns it into an error result.
 *
 * Breaking out of the loop (a throwing progress send, or the chunk cap) cancels the
 * stream through the iterator's `return()`. A normal completion needs no cancel, because
 * the client sends an `unsubscribe` on cancel and the server already ended the run.
 */
const runStream = async (
    client: LunoraClient,
    route: FunctionRoute,
    args: Record<string, unknown>,
    shardKey: string | undefined,
    context: StreamCallContext,
): Promise<ToolResult> => {
    const streamRef: FunctionReference<"stream"> = { __lunoraRef: route.path };
    // The client's default buffer is smaller than the cap, so a fast stream would fail as
    // backpressure before the cap could report it. One past the cap lets the cap decide.
    const iterable = client.stream(streamRef, args, { maxBuffer: MAX_STREAM_CHUNKS + 1, shardKey });
    const { signal, progress } = context;
    const onAbort = (): void => {
        iterable.cancel();
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    if (signal?.aborted === true) {
        onAbort();
    }

    const chunks: unknown[] = [];

    try {
        for await (const chunk of iterable) {
            // Refused on the chunk past the cap, so a stream of exactly the cap still completes.
            if (chunks.length === MAX_STREAM_CHUNKS) {
                iterable.cancel();

                return errorResult(
                    "PAYLOAD_TOO_LARGE",
                    `the stream "${route.path}" yielded more than ${MAX_STREAM_CHUNKS.toString()} chunks, so it was cancelled and no chunks are returned.`,
                );
            }

            chunks.push(chunk);
            await progress?.(chunks.length - 1);
        }
    } finally {
        signal?.removeEventListener("abort", onAbort);
    }

    // A cancel ends the iterator as a normal completion, so the chunks are a prefix of the
    // stream, not all of it. Reporting them as the result would present a partial read as complete.
    if (signal?.aborted === true) {
        return errorResult("CANCELLED", `the stream "${route.path}" was cancelled before it completed, after ${chunks.length.toString()} chunk(s).`);
    }

    return ok(chunks);
};

/**
 * Dispatch one tool call. A query runs at once. A stream runs to completion and
 * returns its chunks. A mutation or action passes the same two-step confirmation
 * the generic write tools use, so a model that calls it directly gets a proposal
 * back and runs nothing.
 *
 * Exported so the gate and the handshake can be exercised without a transport.
 */
const callFunctionTool = async (
    client: LunoraClient,
    routes: FunctionTools["routes"],
    name: string,
    input: Record<string, unknown>,
    allowWrites: boolean,
    context: StreamCallContext = {},
): Promise<ToolResult> => {
    const route = routes.get(name);

    if (route === undefined) {
        return errorResult("NOT_FOUND", `unknown tool: ${name}`);
    }

    if (isWrite(route.kind) && !allowWrites) {
        return errorResult("FORBIDDEN", `tool "${name}" is disabled: this MCP server is read-only. Enable writes with allowWrites.`);
    }

    try {
        const rawArgs = readArgumentsBag(input["args"]);
        const shardKey = shardKeyOf(input);

        if (route.kind === "query") {
            return resultOf(route, await client.query(reference(route.path), coerceArgs(route.argsSchema, rawArgs), { shardKey }));
        }

        if (route.kind === "stream") {
            return await runStream(client, route, coerceArgs(route.argsSchema, rawArgs), shardKey, context);
        }

        return await runWrite(client, route, name, input, rawArgs, shardKey);
    } catch (error: unknown) {
        return errorFromThrown(error);
    }
};

/**
 * The client for the deployment the server should call now. It is built when a call
 * first sees a URL, and rebuilt when the URL moves. The bearer is set on both the HTTP
 * client and the WebSocket one, because a stream authenticates through the latter.
 * `release` closes the cached client, which ends any stream socket it opened.
 */
const clientFor = (options: FunctionMcpServerOptions): { clientOf: () => LunoraClient | undefined; release: () => void } => {
    let current: { client: LunoraClient; url: string } | undefined;

    const release = (): void => {
        current?.client.close();
        current = undefined;
    };

    const clientOf = (): LunoraClient | undefined => {
        const url = typeof options.url === "function" ? options.url() : options.url;

        // A URL that returns later gets a fresh client, even when it is the same string.
        if (url === undefined || url.length === 0) {
            release();

            return undefined;
        }

        if (current?.url !== url) {
            current?.client.close();

            const client = new LunoraClient({ fetch: options.fetch, url });

            if (options.token !== undefined) {
                client.setAuthToken(options.token);
                client.setWsToken(options.token);
            }

            current = { client, url };
        }

        return current.client;
    };

    return { clientOf, release };
};

/**
 * Build an MCP `Server` with one tool per function in `openRpcSpec`. Transport
 * agnostic: call `.connect(transport)` yourself.
 *
 * Throws at construction when the document is malformed or two functions share a
 * tool name, so a bad integration fails at startup rather than on the first call.
 */
// eslint-disable-next-line sonarjs/deprecation -- see the `Server` import above.
const createFunctionMcpServer = (options: FunctionMcpServerOptions): Server => {
    const allowWrites = options.allowWrites ?? false;
    const resolveSpec = (): unknown => (typeof options.openRpcSpec === "function" ? (options.openRpcSpec as () => unknown)() : options.openRpcSpec);
    const buildTools = (spec: unknown): { spec: unknown; tools: FunctionTools } => {
        return { spec, tools: functionToolsFromOpenRpc(spec, { allowWrites }) };
    };
    let served = buildTools(resolveSpec());
    // A bad rewrite is not an outage: the tools last built keep answering, and a document that
    // failed to build is recorded so it is not rebuilt until it changes again.
    const toolsNow = (): FunctionTools => {
        let spec: unknown;

        try {
            spec = resolveSpec();
        } catch (error: unknown) {
            options.onReloadError?.(error);

            return served.tools;
        }

        if (spec !== served.spec) {
            try {
                served = buildTools(spec);
            } catch (error: unknown) {
                options.onReloadError?.(error);
                served = { spec, tools: served.tools };
            }
        }

        return served.tools;
    };
    const { clientOf, release } = clientFor(options);
    // eslint-disable-next-line sonarjs/deprecation -- see the `Server` import above.
    const server = new Server(
        { name: options.name ?? SERVER_NAME, version: options.version ?? pkg.version },
        { capabilities: { tools: { listChanged: true } } },
    );

    // `serveStateless` closes the server after every request, and the SDK has no hook on
    // close that a caller does not already own (`onclose` is set by the CLI). So the
    // cached client is released by wrapping `close`.
    const closeServer = server.close.bind(server);

    server.close = async (): Promise<void> => {
        release();
        await closeServer();
    };

    server.setRequestHandler(ListToolsRequestSchema, () => {
        return { tools: [...toolsNow().definitions] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
        let client: LunoraClient | undefined;

        try {
            client = clientOf();
        } catch (error: unknown) {
            // A URL resolver that throws is a failed call, not a failed request.
            return errorFromThrown(error);
        }

        if (client === undefined) {
            return errorResult(
                "SERVICE_UNAVAILABLE",
                "no Lunora deployment URL is available yet. Start `lunora dev` or set the deployment URL, then call the tool again.",
            );
        }

        const { progressToken } = extra._meta ?? {};
        const context: StreamCallContext = {
            signal: extra.signal,
            ...(progressToken === undefined
                ? {}
                : {
                      progress: async (chunkIndex: number): Promise<void> => {
                          await extra.sendNotification({ method: "notifications/progress", params: { progress: chunkIndex, progressToken } });
                      },
                  }),
        };

        return callFunctionTool(client, toolsNow().routes, request.params.name, request.params.arguments ?? {}, allowWrites, context);
    });

    return server;
};

export type { FunctionMcpServerOptions };
export { callFunctionTool, createFunctionMcpServer, MAX_STREAM_CHUNKS };
