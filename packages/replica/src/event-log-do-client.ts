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
 *   fetch: (req) => env.EVENT_LOG_DO.get(id).fetch(req),
 * });
 *
 * const entries = await client.getSince(0);
 * await client.append([{ type: "chat.messageSent", payload: { text: "hi" } }]);
 * ```
 */
import type { EventLogEntry } from "./event-log";
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
     * A function that dispatches an HTTP request to the target EventLogDO
     * instance. In a Cloudflare Worker this is:
     *
     * ```ts
     * (req) => env.MY_DO_NAMESPACE.get(id).fetch(req)
     * ```
     */
    fetch: (request: Request) => Promise<Response>;
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

    public constructor(options: EventLogDOClientOptions) {
        this.#fetch = options.fetch;
    }

    // ── Append ─────────────────────────────────────────────────────────

    /**
     * Append one or more events to the log.
     * @returns The persisted entries with their assigned `seq` numbers.
     */
    public async append(events: AppendEventInput[]): Promise<EventLogEntry[]> {
        const body = JSON.stringify({ events });
        const response = await this.#fetch(
            new Request("https://do/append", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
            }),
        );

        if (!response.ok) {
            throw await EventLogDOClient.#toError(response, "append");
        }

        const data = (await response.json()) as { entries: EventLogEntry[] };
        return data.entries;
    }

    // ── Read / replay ───────────────────────────────────────────────────

    /**
     * Fetch all entries with `seq >= sinceSeq`.
     *
     * Pass `sinceSeq = 0` to fetch the entire log.
     */
    public async getSince(sinceSeq: number): Promise<EventLogEntry[]> {
        const response = await this.#fetch(new Request(`https://do/since?seq=${String(sinceSeq)}`));

        if (!response.ok) {
            throw await EventLogDOClient.#toError(response, "getSince");
        }

        const data = (await response.json()) as { entries: EventLogEntry[] };
        return data.entries;
    }

    /**
     * Fetch a paginated range of entries.
     * @returns `{ entries, hasMore }` — `hasMore` is `true` when another
     * page exists (i.e. the DO returned `limit + 1` rows).
     */
    public async getRange(fromSeq: number, limit: number = 50): Promise<{ entries: EventLogEntry[]; hasMore: boolean }> {
        const response = await this.#fetch(new Request(`https://do/range?from=${String(fromSeq)}&limit=${String(limit)}`));

        if (!response.ok) {
            throw await EventLogDOClient.#toError(response, "getRange");
        }

        return (await response.json()) as { entries: EventLogEntry[]; hasMore: boolean };
    }

    /**
     * Return the total number of entries currently in the log.
     */
    public async getSize(): Promise<number> {
        const response = await this.#fetch(new Request("https://do/size"));

        if (!response.ok) {
            throw await EventLogDOClient.#toError(response, "getSize");
        }

        const data = (await response.json()) as { count: number };
        return data.count;
    }

    /**
     * Return the full log state — all entries plus the next seq number.
     */
    public async getState(): Promise<{ entries: EventLogEntry[]; nextSeq: number }> {
        const response = await this.#fetch(new Request("https://do/state"));

        if (!response.ok) {
            throw await EventLogDOClient.#toError(response, "getState");
        }

        return (await response.json()) as { entries: EventLogEntry[]; nextSeq: number };
    }

    // ── Internal ────────────────────────────────────────────────────────

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
