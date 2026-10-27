/**
 * EventLogDOClient — HTTP RPC client for EventLogDO.
 *
 * Wraps the Durable Object's `fetch()`-based RPC surface behind a clean
 * async API so that callers (materializer runtimes, Studio pages, etc.)
 * do not need to craft requests or parse responses manually.
 *
 * ## Usage (Cloudflare Worker)
 *
 * ```ts
 * const client = new EventLogDOClient({
 *   env,
 *   fetch: (req) => env.EVENT_LOG_DO.get(id).fetch(req),
 *   instance: id.toString(),
 * });
 *
 * const { entries } = await client.getSince(0); // first page — see `getSince`
 * await client.append([{ type: "chat.messageSent", payload: { text: "hi" } }]);
 * ```
 */
import { RELAY_SIGNATURE_HEADER, siblingSecretOf, signSiblingBody } from "../../../shared/relay-signature";
import type { EventLogEntry } from "./event-log";
import { eventLogFrame } from "./event-log-frame";
import type { InputEvent, Seq } from "./seq";

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Shape of the `events[]` items sent in a POST `/append` body.
 *
 * Like {@link InputEvent} but with `timestamp` optional — omit it to
 * let the server assign the timestamp.
 * @experimental
 */
export interface AppendEventInput {
    /** Globally-unique client identifier (for offline/optimistic support). */
    readonly clientId?: string;
    /** Causal parent sequence number (ClientSeq for optimistic, GlobalSeq for confirmed). */
    readonly parentSeqNum?: Seq;
    /** Arbitrary JSON-serialisable payload. */
    readonly payload: unknown;
    /** Session identifier within the client. */
    readonly sessionId?: string;
    /** Millisecond timestamp (epoch) — omit to let the server assign it. */
    readonly timestamp?: number;
    /** Event type discriminator. */
    readonly type: string;
}

/**
 * Options for constructing an {@link EventLogDOClient}.
 * @experimental
 */
export interface EventLogDOClientOptions {
    /**
     * The Worker env. The client signs every request with `LUNORA_RELAY_SECRET`
     * read from it, and construction throws when that secret is not set.
     */
    env: unknown;

    /**
     * A function that dispatches an HTTP request to the target EventLogDO
     * instance. In a Cloudflare Worker this is:
     *
     * ```ts
     * (req) => env.MY_DO_NAMESPACE.get(id).fetch(req)
     * ```
     */
    fetch: (request: Request) => Promise<Response>;

    /**
     * The `DurableObjectId` string of the instance `fetch` dispatches to:
     * `id.toString()` for the `id` passed to `get()`. It is signed into every
     * request, and the instance refuses a request signed for any other id, so
     * a signed request captured from one log cannot be replayed against another.
     */
    instance: string;
}

// ── Client ─────────────────────────────────────────────────────────────

/**
 * Lightweight HTTP client for EventLogDO's RPC surface.
 *
 * Each method maps to one of the DO's endpoints, throws on non-OK status,
 * and returns the parsed response body.
 * @experimental
 */
export class EventLogDOClient {
    readonly #fetch: (request: Request) => Promise<Response>;

    readonly #secret: string;

    readonly #instance: string;

    public constructor(options: EventLogDOClientOptions) {
        const secret = siblingSecretOf(options.env);

        if (secret === undefined) {
            throw new Error(
                "EventLogDOClient requires LUNORA_RELAY_SECRET in env: set it to the relay secret of the worker that hosts EventLogDO (in .dev.vars for local development, or with `wrangler secret put` on deploy)",
            );
        }

        this.#fetch = options.fetch;
        this.#secret = secret;
        this.#instance = options.instance;
    }

    // ── Append ─────────────────────────────────────────────────────────

    /**
     * Append one or more events to the log.
     * @param events The events to append.
     * @param options Idempotency controls for the batch.
     * @param options.batchId Idempotency key for the whole batch. Omit it for a
     * fresh key per call; pass the same key to retry a call whose response was
     * lost (e.g. a network timeout that hid a successful append), which returns
     * the originally-persisted entries instead of inserting duplicates.
     * @returns The persisted entries with their assigned `seq` numbers.
     */
    public async append(events: AppendEventInput[], options?: { batchId?: string }): Promise<EventLogEntry[]> {
        // Every append carries a key: the DO refuses one without it, and the key is what makes a captured, replayed request a no-op.
        const body = JSON.stringify({ events, batchId: options?.batchId ?? crypto.randomUUID() });
        const response = await this.#send("POST", "/append", body);

        if (!response.ok) {
            throw await EventLogDOClient.#toError(response, "append");
        }

        const data = (await response.json()) as { entries: EventLogEntry[] };
        return data.entries;
    }

    // ── Read / replay ───────────────────────────────────────────────────

    /**
     * Fetch ONE page of entries with `seq >= sinceSeq`.
     *
     * The DO bounds every page (500 entries unless `limit` says otherwise, 1000
     * max), so `getSince(0)` is the START of the log, never all of it — a
     * catch-up walks pages until `truncated` is `false`:
     *
     * ```ts
     * let seq = 0;
     * for (;;) {
     *   const page = await client.getSince(seq);
     *   apply(page.entries);
     *   if (!page.truncated || page.cursor === undefined) break;
     *   seq = page.cursor;
     * }
     * ```
     * @returns `{ entries, truncated, cursor }` — `cursor` is the `sinceSeq`
     * for the next page and is present exactly when `truncated` is `true`.
     */
    public async getSince(sinceSeq: number, limit?: number): Promise<{ cursor?: number; entries: EventLogEntry[]; truncated: boolean }> {
        const limitQuery = limit === undefined ? "" : `&limit=${String(limit)}`;

        return this.#get(`/since?seq=${String(sinceSeq)}${limitQuery}`, "getSince");
    }

    /**
     * Return the total number of entries currently in the log.
     */
    public async getSize(): Promise<number> {
        const data = await this.#get<{ count: number }>("/size", "getSize");

        return data.count;
    }

    /**
     * Return the full log state — all entries plus the next seq number.
     *
     * Only for a log small enough to answer as one body: the DO refuses with a
     * 413 past its page ceiling, since serialising an unbounded log into one
     * response is what {@link EventLogDOClient.getSince} was bounded to avoid.
     * A catch-up walks `getSince` instead.
     * @throws Error when the log is too large to return in one body
     */
    public async getState(): Promise<{ entries: EventLogEntry[]; nextSeq: number }> {
        return this.#get("/state", "getState");
    }

    // ── Internal ────────────────────────────────────────────────────────

    /**
     * Send one signed request. The URL is built once and both the request and
     * the signed frame are taken from it, so the path the DO verifies is the
     * path it receives.
     */
    async #send(method: "GET" | "POST", path: string, body = ""): Promise<Response> {
        const url = new URL(`https://do${path}`);
        const signature = await signSiblingBody(this.#secret, eventLogFrame(this.#instance, method, url, body));
        const headers: Record<string, string> = { [RELAY_SIGNATURE_HEADER]: signature };

        if (method === "POST") {
            headers["content-type"] = "application/json";
        }

        return this.#fetch(new Request(url.href, { method, headers, body: method === "POST" ? body : undefined }));
    }

    /** GET `path` from the DO, throwing a descriptive error on a non-OK status. */
    async #get<T>(path: string, operation: string): Promise<T> {
        const response = await this.#send("GET", path);

        if (!response.ok) {
            throw await EventLogDOClient.#toError(response, operation);
        }

        return (await response.json()) as T;
    }

    /** Parse an error response body and return a descriptive `Error`. */
    static async #toError(response: Response, method: string): Promise<Error> {
        try {
            const body = (await response.json()) as {
                error?: { code?: string; message?: string };
            };
            const message = body.error?.message ?? response.statusText;
            return new Error(`EventLogDO.${method} failed (${String(response.status)}): ${message}`);
        } catch {
            return new Error(`EventLogDO.${method} failed (${String(response.status)}): ${response.statusText}`);
        }
    }
}
