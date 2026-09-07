/* eslint-disable sonarjs/deprecation -- the SDK marks the low-level `Server` @deprecated in favour of the high-level `McpServer`, but explicitly sanctions `Server` for "advanced use cases". Ours qualifies: we dispatch tools defined with plain JSON Schema and bridge structured results ourselves, which avoids McpServer's per-tool zod dependency (matching `server.ts`). */

/**
 * x402-gated (paid) MCP tools, exported from the package root.
 *
 * A Lunora app authors its own MCP tools and prices some of them in USDC. Free
 * `tool()` and `paidTool()` registrations coexist on one server (mirroring
 * Cloudflare's `withX402(server, config)`). The server is served over
 * Streamable HTTP (paid tools require an HTTP boundary — an HTTP request can
 * carry `X-PAYMENT`, which stdio cannot), and each `tools/call` for a **paid**
 * tool is gated by the Phase-1 charge middleware: unpaid → `402` +
 * `PAYMENT-REQUIRED`; verified → settle, dispatch, attach `X-PAYMENT-RESPONSE`.
 * Settlement precedes dispatch (x402's `settleBeforeHandler` default, which this
 * module does not override), so a tool that throws has already been paid for —
 * which is why a throwing handler returns an `isError` result rather than a
 * JSON-RPC protocol error the client may not surface.
 *
 * ```ts
 * const mcp = createPaidMcpServer({ charge: { network: "base", recipient: { evm: env.PAYOUT } } });
 * mcp.tool({ name: "ping", description: "health check", inputSchema: { properties: {}, type: "object" } }, () => text("pong"));
 * mcp.paidTool(
 *   { name: "premium_report", description: "the paid report", inputSchema: { properties: {}, type: "object" }, price: "$0.05" },
 *   async () => text(await buildReport()),
 * );
 * export default { fetch: mcp.fetchHandler };
 * ```
 *
 * `fetchHandler` takes the Worker's `(request, env, ctx)` triple, so mounting it
 * as the default export above is all that is needed — it forwards `ctx.waitUntil`
 * to the charge middleware, which is what keeps an `onReceipt` sink alive past
 * the response. Call it with a bare `Request` and a settled payment's receipt is
 * cancelled at isolate teardown while the money has already moved on-chain.
 */
import { LunoraError } from "@lunora/errors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { memoizePromise } from "../../../shared/promise-memo";
import { readScreenedBody, serveStateless } from "./serve-stateless";
import type { ToolInputSchema, ToolResult } from "./tools";

/** A tool handler: receives the call's `arguments` bag, returns an MCP tool result. */

/**
 * The x402 vocabulary this module needs, declared here rather than imported.
 *
 * The x402 package is an optional peer, and a type import from its `charge`
 * entry puts its `.d.ts` back into this package's build graph:
 * a consumer that never installs x402 never builds it either, so the dts bundler
 * looks for a `dist/` that does not exist and fails. That is not hypothetical —
 * it broke the docs site build, which runs a filtered build over the docs app and its dependency closure
 * and therefore never builds x402.
 *
 * Declaring them locally is safe because this module never *inspects* a charge
 * config; it forwards it whole to `createChargeMiddleware`. The index signature
 * keeps a real charge config assignable as x402 grows fields.
 */

/** Mirrors x402's `X402Price` — a decimal string like `"$0.05"`, or a number. */
type X402Price = number | string;

/** Mirrors x402's charge config with the per-tool price omitted. */
interface X402ChargeSettings {
    /** Network this resource settles on. */
    readonly network: string;
    /** Everything else x402 accepts, forwarded untouched. */
    readonly [key: string]: unknown;

    /** Payout wallet(s), per network family. */
    readonly recipient: { readonly evm?: string; readonly svm?: string };
}

/** Mirrors x402's `ChargeHandlerDeps` — the per-request platform seams `handle` uses. */
interface ChargeHandlerDeps {
    /** Keeps the `onReceipt` sink alive past the response — the request's `ctx.waitUntil`. */
    readonly waitUntil: (promise: Promise<unknown>) => void;
}

/** Mirrors `ChargeMiddleware` — the one method this module calls. */
interface ChargeMiddleware {
    handle: (request: Request, runHandler: () => Promise<Response>, deps?: ChargeHandlerDeps) => Promise<Response>;
}

/** The factory `@lunora/x402/charge` exports, as this module uses it. */
type CreateChargeMiddleware = (config: X402ChargeSettings & { price: X402Price }, context: { resource: string }) => Promise<ChargeMiddleware>;

type ToolHandler = (arguments_: Record<string, unknown>) => Promise<ToolResult> | ToolResult;

/** Registration shape for a free tool. */
interface RegisterToolOptions {
    /** Optional MCP tool annotations (`readOnlyHint`, `title`, …). */
    annotations?: Tool["annotations"];
    /** Human/model-facing description of what the tool does. */
    description: string;
    /** JSON-Schema object describing the tool's arguments. */
    inputSchema: ToolInputSchema;
    /** Unique tool name (the MCP `tools/call` `name`). */
    name: string;
}

/** Registration shape for a paid tool: a {@link RegisterToolOptions} plus its USD price. */
interface RegisterPaidToolOptions extends RegisterToolOptions {
    /** USD price per call (e.g. `"$0.05"`), charged via x402 before dispatch. */
    price: X402Price;
}

/** x402 settlement vocabulary shared by every paid tool (network, recipient, facilitator); price is per-tool. */
type PaidMcpChargeConfig = X402ChargeSettings;

/** Config for `createPaidMcpServer`. */
interface PaidMcpServerConfig {
    /** The worker-level x402 charge config; each paid tool supplies only its own `price`. */
    charge: PaidMcpChargeConfig;

    /**
     * Largest accepted request body, in bytes — enforced while the body streams
     * in, not after it is buffered. Defaults to `DEFAULT_MAX_REQUEST_BYTES`
     * (128 KiB), which a value that is not a non-negative safe integer also
     * falls back to.
     */
    maxRequestBytes?: number;
    /** Name/version advertised in the MCP `initialize` handshake. Defaults to `lunora-paid-mcp`. */
    serverInfo?: { name: string; version: string };
}

/**
 * The Worker execution context, as this module reads it: only `waitUntil`, and
 * structurally, so the package takes no `@cloudflare/workers-types` dependency.
 */
interface PaidMcpExecutionContext {
    waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * The paid server's fetch handler.
 *
 * Unlike the free `McpFetchHandler` it takes the Worker's full
 * `(request, env, ctx)` triple — the shape `export default { fetch }` is called
 * with — because the x402 receipt sink NEEDS `ctx.waitUntil`: work that is
 * neither awaited into the response nor registered with it is cancelled when the
 * request ends, so an async `onReceipt` (inserting the settled payment into a
 * durable table) frequently never runs while the money has already moved
 * on-chain. `env` is accepted and ignored so the handler drops straight into the
 * default export; both are optional, so a non-Workers caller may still invoke it
 * with a bare `Request` (the middleware then simply sees no `waitUntil`).
 */
type PaidMcpFetchHandler = (request: Request, env?: unknown, context?: PaidMcpExecutionContext) => Promise<Response>;

/** A paid MCP server: register free/paid tools, then serve over Streamable HTTP. */
interface PaidMcpServer {
    /** The Streamable-HTTP fetch handler; gates each paid `tools/call` behind x402. */
    readonly fetchHandler: PaidMcpFetchHandler;
    /** Register a **paid** tool: its dispatch runs the x402 charge middleware first. */
    paidTool: (options: RegisterPaidToolOptions, handler: ToolHandler) => void;
    /** Register a **free** tool (coexists with paid tools on the same server). */
    tool: (options: RegisterToolOptions, handler: ToolHandler) => void;
}

/** A registered tool: its advertised definition plus the dispatch handler. */
interface RegisteredTool {
    definition: Tool;
    handler: ToolHandler;
}

/** Default server identity when the caller doesn't supply one. */

/**
 * Load the x402 charge factory on first use.
 *
 * `@lunora/x402` is an OPTIONAL peer dependency, kept behind a dynamic import so
 * it stays out of the module graph until a paid tool is actually priced. A
 * static import would put its dependency tree — viem, the Solana kit, the x402
 * packages, tens of megabytes — into every install of every consumer of this
 * package, including `@lunora/cli`, which never charges for anything. A missing
 * install is reported as the actionable "install this" rather than as a bare
 * module-resolution failure.
 */
const loadChargeMiddleware = async (): Promise<CreateChargeMiddleware> => {
    try {
        // Cast at this one boundary: the module is resolved at runtime only, so
        // its real types are deliberately absent from this build.
        const loaded = (await import("@lunora/x402/charge")) as unknown as { createChargeMiddleware: CreateChargeMiddleware };

        return loaded.createChargeMiddleware;
    } catch (error: unknown) {
        throw new LunoraError(
            "INTERNAL",
            `paid MCP tools need the optional peer "@lunora/x402" — install it alongside @lunora/mcp to charge for tools (${error instanceof Error ? error.message : String(error)})`,
        );
    }
};

const DEFAULT_SERVER_INFO = { name: "lunora-paid-mcp", version: "0.0.0" } as const;

/** The MCP method that invokes a tool — the only method a price gate applies to. */
const CALL_TOOL_METHOD = "tools/call";

/**
 * The tool name a JSON-RPC message targets, if it is a `tools/call`. Returns
 * `undefined` for any other method or a malformed message — those are never
 * gated (only a `tools/call` naming a registered paid tool is).
 */
const callToolName = (message: unknown): string | undefined => {
    if (typeof message !== "object" || message === null) {
        return undefined;
    }

    const { method, params } = message as { method?: unknown; params?: unknown };

    if (method !== CALL_TOOL_METHOD || typeof params !== "object" || params === null) {
        return undefined;
    }

    const { name } = params as { name?: unknown };

    return typeof name === "string" ? name : undefined;
};

/**
 * Refuse a JSON-RPC batch that references a paid tool. A single HTTP request
 * carries at most one `X-PAYMENT`, so it can't settle several priced calls;
 * rather than let a batched paid call slip through unpaid we fail closed. MCP
 * 2025-06-18 removed JSON-RPC batching, so this is a defensive belt.
 */
const refuseBatch = (): Response =>
    Response.json({ error: "A JSON-RPC batch may not reference a paid MCP tool; send paid tools/call requests individually." }, { status: 400 });

/**
 * Create a paid MCP server. Register free tools with `tool()` and priced tools
 * with `paidTool()` (they coexist), then serve `fetchHandler` over HTTP.
 *
 * The server is **stateless**: `fetchHandler` builds a fresh `Server` per
 * request (reading the live tool registry), so tools registered before the
 * first request are all visible. Each priced tool memoises one initialised
 * `ChargeMiddleware` (keyed by tool name, baking that tool's price and naming
 * the tool as the challenge `resource`); a failed init is not cached, so a
 * transient facilitator outage retries on the next call.
 */
const createPaidMcpServer = (config: PaidMcpServerConfig): PaidMcpServer => {
    const tools = new Map<string, RegisteredTool>();
    const prices = new Map<string, X402Price>();
    const middlewareByTool = new Map<string, Promise<ChargeMiddleware>>();
    const serverInfo = config.serverInfo ?? DEFAULT_SERVER_INFO;

    const register = (options: RegisterToolOptions, handler: ToolHandler, price?: X402Price): void => {
        if (tools.has(options.name)) {
            throw new LunoraError("BAD_REQUEST", `MCP tool "${options.name}" is already registered.`);
        }

        // `ToolInputSchema` (properties: `Record<string, unknown>`) is structurally
        // a valid JSON-Schema object; the SDK's `Tool.inputSchema` types property
        // values as `object` — cast to bridge the narrower value type.
        const definition: Tool = { description: options.description, inputSchema: options.inputSchema as Tool["inputSchema"], name: options.name };

        if (options.annotations !== undefined) {
            definition.annotations = options.annotations;
        }

        tools.set(options.name, { definition, handler });

        if (price !== undefined) {
            prices.set(options.name, price);
        }
    };

    // Build a fresh registry-backed `Server` (the stateless transport connects one per request).
    const buildServer = (): Server => {
        const server = new Server(serverInfo, { capabilities: { tools: {} } });

        server.setRequestHandler(ListToolsRequestSchema, () => {
            return { tools: [...tools.values()].map((entry) => entry.definition) };
        });

        server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
            const entry = tools.get(request.params.name);

            // Unknown tools surface as an `isError` result (not a rejection), per
            // the MCP convention `callTool` follows in `tools.ts`.
            if (entry === undefined) {
                return { content: [{ text: `unknown tool: ${request.params.name}`, type: "text" }], isError: true };
            }

            try {
                return (await entry.handler(request.params.arguments ?? {})) as CallToolResult;
            } catch (error: unknown) {
                // An `isError` result, not a rejection — the SDK turns a handler
                // rejection into a JSON-RPC protocol `error`, which a client that
                // renders only tool results shows the model as nothing at all. On
                // this transport the payment has ALREADY settled by the time
                // dispatch runs, so "paid, and the model saw no answer" is the
                // failure to avoid. Matches `compose.ts` / `tools.ts`.
                return { content: [{ text: error instanceof Error ? error.message : String(error), type: "text" }], isError: true };
            }
        });

        return server;
    };

    // The initialised charge middleware for a paid tool, memoised (built once,
    // reused). `memoizePromise` owns the coalescing and the don't-cache-a-failure
    // eviction, so a transient facilitator outage retries on the next call.
    const gateFor = (name: string, price: X402Price): Promise<ChargeMiddleware> =>
        memoizePromise(middlewareByTool, name, async () => {
            // `@lunora/x402` is an OPTIONAL peer, imported only when a paid tool
            // is actually charged. A static import would put its dependency tree
            // (viem, the Solana kit, the x402 packages — tens of megabytes) into
            // every install of every consumer of this package, including the CLI,
            // which never charges anything.
            const create = await loadChargeMiddleware();

            return create({ ...config.charge, price }, { resource: name });
        });

    const fetchHandler: PaidMcpFetchHandler = async (request: Request, _env?: unknown, context?: PaidMcpExecutionContext): Promise<Response> => {
        // Peek the JSON-RPC body from a clone so `request` stays pristine for both
        // the charge middleware (reads headers/URL) and the transport (below).
        // Through the SHARED bounded read: a bare `request.clone().json()` here
        // buffers whatever the caller sent, and handing the result on as
        // `parsedBody` enters the transport past its size check — which left
        // this, the one unauthenticated paid surface, with no body limit at all.
        const screened = await readScreenedBody(request.clone(), config.maxRequestBytes);

        if ("response" in screened) {
            return screened.response;
        }

        const { parsedBody } = screened;

        // Hand the already-parsed body to the transport so it doesn't re-read the
        // consumed stream. `parsedBody` is `undefined` only for a GET/DELETE
        // handshake, which carries no body: `readScreenedBody` refuses a POST it
        // could not parse, so this module never has to guess whether an
        // unreadable body targeted a priced tool.
        const dispatch = (): Promise<Response> =>
            serveStateless(
                buildServer(),
                request,
                parsedBody === undefined ? { maxRequestBytes: config.maxRequestBytes } : { maxRequestBytes: config.maxRequestBytes, parsedBody },
            );

        if (Array.isArray(parsedBody)) {
            return parsedBody.some((message) => prices.has(callToolName(message) ?? "")) ? refuseBatch() : dispatch();
        }

        const name = callToolName(parsedBody);
        const price = name === undefined ? undefined : prices.get(name);

        // Free tool, or any non-`tools/call` method (initialize, tools/list, …):
        // dispatch without a paywall.
        if (name === undefined || price === undefined) {
            return dispatch();
        }

        const middleware = await gateFor(name, price);

        // Invoked THROUGH the context, never as a detached function.
        // `ExecutionContext.waitUntil` is receiver-bound and throws
        // `TypeError: Illegal invocation` when called unbound — and x402's
        // `reportReceipt` swallows that throw, so the paid response would still
        // land while the receipt promise was never registered.
        const deps =
            typeof context?.waitUntil === "function"
                ? {
                      waitUntil: (promise: Promise<unknown>): void => {
                          context.waitUntil?.(promise);
                      },
                  }
                : undefined;

        return middleware.handle(request, dispatch, deps);
    };

    const paidTool = (options: RegisterPaidToolOptions, handler: ToolHandler): void => {
        register(options, handler, options.price);
    };

    const tool = (options: RegisterToolOptions, handler: ToolHandler): void => {
        register(options, handler);
    };

    return { fetchHandler, paidTool, tool };
};

export type {
    PaidMcpChargeConfig,
    PaidMcpExecutionContext,
    PaidMcpFetchHandler,
    PaidMcpServer,
    PaidMcpServerConfig,
    RegisterPaidToolOptions,
    RegisterToolOptions,
    ToolHandler,
};
export { createPaidMcpServer };
