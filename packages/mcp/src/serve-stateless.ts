/* eslint-disable sonarjs/deprecation -- the SDK marks the low-level `Server` @deprecated in favour of the high-level `McpServer`, but explicitly sanctions `Server` for "advanced use cases" (matching `server.ts`); here it appears only as a parameter type. */

/**
 * Drive one MCP request through a **stateless** Streamable-HTTP transport.
 *
 * Split out of `./http` so a Workers/browser-targeted surface (notably
 * `./docs`) can reach it without importing `./server`, which reads
 * `package.json` off disk at module load and would drag `node:fs` into the
 * bundle. `./http` re-exports it, so its public API is unchanged.
 *
 * Being the one place every HTTP handler in the package funnels through, it is
 * also where the request is screened — see {@link screenRequest}.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { HandleRequestOptions } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/** A Web-Standard fetch handler: takes a `Request`, returns the MCP `Response`. */
type McpFetchHandler = (request: Request) => Promise<Response>;

/**
 * Largest request body served. Every MCP call is a short JSON-RPC message — a
 * few hundred bytes — so this is orders of magnitude of headroom while still
 * bounding what a caller can push through the parser.
 */
const DEFAULT_MAX_REQUEST_BYTES: number = 128 * 1024;

/** What {@link serveStateless} accepts on top of the transport's own options. */
interface ServeStatelessOptions extends HandleRequestOptions {
    /**
     * Largest accepted request body, in bytes — enforced while the body streams
     * in, not after it is buffered. Defaults to
     * {@link DEFAULT_MAX_REQUEST_BYTES}, which a value that is not a
     * non-negative safe integer also falls back to (see `resolveLimit`).
     */
    maxRequestBytes?: number;
}

/**
 * The byte budget one read is allowed, from a caller-supplied `maxRequestBytes`.
 *
 * `NaN`, `Infinity`, a negative value and a fractional one all describe a bound
 * no comparison can enforce — `total > NaN` is always `false` and `total >
 * Infinity` never fires — so a nonsense option would leave the surface with no
 * limit at all. Anything that is not a non-negative safe integer therefore falls
 * back to {@link DEFAULT_MAX_REQUEST_BYTES}: a misconfigured deployment gets the
 * documented 128 KiB bound rather than an unbounded one.
 */
const resolveLimit = (limit: number | undefined): number =>
    limit !== undefined && Number.isSafeInteger(limit) && limit >= 0 ? limit : DEFAULT_MAX_REQUEST_BYTES;

/**
 * Drain a request body to text, aborting the moment cumulative bytes exceed
 * `limit`; `undefined` signals that abort.
 *
 * `request.text()` cannot serve here: it buffers the WHOLE body into the isolate
 * before any check can look at it, so a chunked POST — one that omits
 * `content-length`, or lies about it — pushes an arbitrary number of bytes
 * through before a size check ever runs. The limit has to be applied as the
 * bytes arrive, which also means counting UTF-8 bytes off the wire rather than
 * `String.length` (UTF-16 code units: 128 KiB of three-byte UTF-8 is ~43k units,
 * which a naive length check would wave through). The reader is cancelled on the
 * abort so the rest of the upload is never pulled.
 */
const readBoundedText = async (request: Request, limit: number): Promise<string | undefined> => {
    if (!request.body) {
        return "";
    }

    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = "";

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- drain the body stream until the reader signals `done`
    while (true) {
        // eslint-disable-next-line no-await-in-loop -- stream reads are inherently sequential; each chunk depends on the prior read
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a stream read can yield `done: false` with an undefined `value`; guard before reading byteLength
        if (value) {
            total += value.byteLength;

            if (total > limit) {
                // Stop pulling; release the underlying stream so the remaining
                // chunks are never read into the isolate.
                //
                // NOT awaited. The paid gate screens `request.clone()`, whose
                // body is one branch of a tee, and `tee()`'s cancel promise
                // settles only once BOTH branches are cancelled — awaiting it
                // there hangs the handler forever on the exact oversized request
                // this limit exists to shed. Nothing downstream needs the
                // cancellation to have completed.
                reader.cancel().catch(() => undefined);

                return undefined;
            }

            text += decoder.decode(value, { stream: true });
        }
    }

    return text + decoder.decode();
};

/** Either a rejection to return as-is, or the parsed body to hand to the transport. */
type ScreenedRequest = { parsedBody: unknown } | { response: Response };

/**
 * A JSON-RPC error response, as its own HTTP response.
 *
 * `id: null` is the protocol's own requirement for an error that cannot be
 * correlated to a request id — which is exactly the case when the body was
 * rejected before it was understood.
 */
const rpcError = (status: number, code: number, message: string): Response =>
    // eslint-disable-next-line unicorn/no-null -- JSON-RPC 2.0 specifies `null`, not an absent field, for an uncorrelated error
    Response.json({ error: { code, message }, id: null, jsonrpc: "2.0" }, { status });

/** The batch refusal, shared by both screening paths so they answer identically. */
const batchRefusal = (): Response => rpcError(400, -32_600, "batched requests are not supported: send one JSON-RPC message per request");

/**
 * Read and JSON-parse a POST body, bounded by `maxRequestBytes` **as the bytes
 * arrive** ({@link readBoundedText}) rather than after the body is buffered, so
 * a chunked upload carrying no honest `content-length` is cut off at the limit
 * instead of being read whole and measured afterwards. A nonsense limit is
 * itself rejected — see {@link resolveLimit}.
 *
 * The size limit lives HERE rather than inside {@link screenRequest} because a
 * caller that needs the body before the transport does — the paid-tool gate,
 * which prices a `tools/call` from its JSON-RPC `method`/`params` — would
 * otherwise buffer an unbounded body with `request.json()` and hand the result
 * over as `parsedBody`, entering {@link screenRequest} past every check. One
 * bounded read, shared by both, is the only shape where every transport in the
 * package has a body limit.
 *
 * Batches are NOT refused here: the paid gate answers them with its own
 * envelope (a batch may reference a priced tool), so that decision stays with
 * each caller.
 */
const readScreenedBody = async (request: Request, limit?: number): Promise<ScreenedRequest> => {
    // GET (SSE stream open) and DELETE (session termination) carry no body by
    // spec, so there is nothing to bound and nothing to parse.
    if (request.method !== "POST") {
        return { parsedBody: undefined };
    }

    const maxRequestBytes = resolveLimit(limit);
    const tooLarge = { response: rpcError(413, -32_600, `request body exceeds ${String(maxRequestBytes)} bytes`) };
    const declaredLength = Number(request.headers.get("content-length"));

    // Reject on the declared length FIRST, so an honestly-labelled oversized
    // body is refused without opening the stream at all. The header is
    // forgeable and a chunked request omits it entirely, which is why the
    // authoritative bound is the streaming one below — but the common case
    // costs nothing.
    if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
        return tooLarge;
    }

    const body = await readBoundedText(request, maxRequestBytes);

    if (body === undefined) {
        return tooLarge;
    }

    try {
        return { parsedBody: JSON.parse(body) };
    } catch {
        return { response: rpcError(400, -32_700, "parse error: body is not valid JSON") };
    }
};

/**
 * Reject what no MCP handler in this package has a reason to accept, before the
 * transport sees it.
 *
 * Two limits close the gap between "cheap request" and "expensive response":
 *
 * - **Body size.** Bounded so a large body can't be pushed through the parser.
 * - **No JSON-RPC batches.** The spec allows an array of messages, and the
 * stateless transport buffers the whole batch's replies into one body before
 * responding — so a single small request carrying thousands of `tools/call`
 * messages amplifies into hundreds of megabytes out, with no `initialize` and no
 * session to rate-limit against.
 *
 * Both matter more, not less, once a token is involved: on the OAuth-protected
 * and admin-token handlers a batch turns one authorized POST into thousands of
 * privileged upstream calls, each carrying the deployment's bearer. That is why
 * this lives here — the shared transport entry every handler routes through —
 * rather than on the one unauthenticated surface that first needed it.
 *
 * Returns the rejection `Response`, or the already-parsed body to hand to the
 * transport so it isn't read twice.
 */
const screenRequest = async (request: Request, options: ServeStatelessOptions | undefined): Promise<ScreenedRequest> => {
    if (request.method !== "POST") {
        return { parsedBody: options?.parsedBody };
    }

    // A caller that already read the body (the paid-tool gate peeks the
    // JSON-RPC message to price the call) hands it over, so re-reading the
    // consumed stream is neither possible nor needed — only the batch refusal
    // is left to apply. Such a caller MUST have read it through
    // {@link readScreenedBody}: this branch is past the size limit, and the one
    // that skipped it left a public endpoint with no body bound at all.
    if (options?.parsedBody !== undefined) {
        return Array.isArray(options.parsedBody) ? { response: batchRefusal() } : { parsedBody: options.parsedBody };
    }

    const screened = await readScreenedBody(request, options?.maxRequestBytes);

    if ("response" in screened) {
        return screened;
    }

    return Array.isArray(screened.parsedBody) ? { response: batchRefusal() } : screened;
};

/**
 * Drive one request through a fresh **stateless** Streamable-HTTP transport bound
 * to `server`, then tear both down.
 *
 * `sessionIdGenerator: undefined` → stateless (no cross-request session store);
 * `enableJsonResponse: true` → the whole JSON-RPC response is buffered into the
 * returned `Response`, so closing the transport/server afterwards can't truncate
 * an in-flight body. Cleanup is fire-and-forget with swallowed rejections (a
 * `.catch()`-terminated chain) so it never delays or masks the resolved response.
 *
 * The request is screened first ({@link screenRequest}); an oversized body or a
 * JSON-RPC batch is refused here and no server is ever constructed for it.
 *
 * `options.parsedBody` lets a caller hand over a body it already read (e.g. the
 * paid-tool gate, which peeks the JSON-RPC message to price the call) so the
 * transport doesn't re-read a consumed stream. It is trusted as already
 * screened, so read it with {@link readScreenedBody} — anything else hands this
 * surface an unbounded body.
 *
 * Teardown runs in a `finally`: a rejection from `connect` or `handleRequest`
 * would otherwise skip it and leak a server + transport per failed request,
 * which on a public endpoint is exactly the request an attacker can repeat.
 */
const serveStateless = async (server: Server, request: Request, options?: ServeStatelessOptions): Promise<Response> => {
    const screened = await screenRequest(request, options);

    if ("response" in screened) {
        return screened.response;
    }

    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined });

    try {
        await server.connect(transport);

        return await transport.handleRequest(request, { authInfo: options?.authInfo, parsedBody: screened.parsedBody });
    } finally {
        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);
    }
};

export type { McpFetchHandler, ServeStatelessOptions };
export { DEFAULT_MAX_REQUEST_BYTES, readScreenedBody, serveStateless };
