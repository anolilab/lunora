/**
 * Durable Object that owns auth session state.
 *
 * `@cirrus/auth` used to write sessions directly into D1 alongside user
 * records. That worked but coupled session lifecycle to a global database —
 * every read had to cross the region, every write contended with user
 * inserts. SessionDO owns sessions in a DO-local KV store: same-prefix
 * tokens co-locate (via `idFromName(token.slice(0, 16))`) so the DO instance
 * count stays bounded; reads and writes never round-trip to D1.
 *
 * Wire shape: HTTP only, never RPC. The auth package calls
 *
 *     await env.SESSION.get(env.SESSION.idFromName(prefix)).fetch(...)
 *
 * with one of:
 *
 *   POST   /create   body: { token, userId, ttlSeconds }
 *   GET    /get?token=...
 *   DELETE /revoke?token=...
 *
 * The DO returns JSON bodies that `@cirrus/auth` reshapes into its public
 * `AuthSession` type. Keep the surface narrow — anything more elaborate
 * should ride on top via a wrapper, not by widening this contract.
 */

/** Default TTL for new sessions (7 days), matching `@cirrus/auth`. */
export const SESSION_DO_TTL_DEFAULT: number = 7 * 24 * 60 * 60;

/**
 * Persisted session payload. Stored under `s:${token}` so the token never
 * leaves the cookie — we only ever look up by exact match.
 */
export interface SessionRecord {
    createdAt: number;
    expiresAt: number;
    userId: string;
}

/**
 * Subset of `DurableObjectState` we touch. Declared structurally so unit
 * tests can pass a plain object without depending on the workers runtime.
 */
interface SessionDOState {
    storage: {
        delete: (key: string) => Promise<boolean | number>;
        get: <T = unknown>(key: string) => Promise<T | undefined>;
        put: <T = unknown>(key: string, value: T) => Promise<void>;
    };
}

const jsonResponse = (status: number, body: unknown): Response =>
    Response.json(body, {
        status,
        headers: { "content-type": "application/json" },
    });

/**
 * Concrete (not abstract) DO class. Apps register this binding directly in
 * their `wrangler.jsonc` as `SESSION` — no subclassing required.
 */
export class SessionDO {
    protected state: SessionDOState;

    protected env: unknown;

    constructor(state: SessionDOState, env: unknown) {
        this.state = state;
        this.env = env;
    }

    public async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (request.method === "POST" && url.pathname === "/create") {
            let body: { token?: unknown; ttlSeconds?: unknown; userId?: unknown };

            try {
                body = (await request.json()) as typeof body;
            } catch {
                return jsonResponse(400, { error: { code: "BAD_REQUEST", message: "invalid JSON body" } });
            }

            const token = typeof body.token === "string" ? body.token : "";
            const userId = typeof body.userId === "string" ? body.userId : "";
            const ttlSeconds = typeof body.ttlSeconds === "number" && body.ttlSeconds > 0 ? body.ttlSeconds : SESSION_DO_TTL_DEFAULT;

            if (!token || !userId) {
                return jsonResponse(400, { error: { code: "INVALID_INPUT", message: "token and userId required" } });
            }

            const now = Date.now();
            const record: SessionRecord = { userId, createdAt: now, expiresAt: now + ttlSeconds * 1000 };

            await this.state.storage.put(`s:${token}`, record);

            return jsonResponse(201, { token, ...record });
        }

        if (request.method === "GET" && url.pathname === "/get") {
            const token = url.searchParams.get("token");

            if (!token) {
                return jsonResponse(400, { error: { code: "INVALID_INPUT", message: "token required" } });
            }

            const record = await this.state.storage.get<SessionRecord>(`s:${token}`);

            if (!record) {
                return jsonResponse(404, { error: { code: "NOT_FOUND", message: "session not found" } });
            }

            // Expire lazily on read so we don't need an alarm just to GC.
            if (record.expiresAt < Date.now()) {
                await this.state.storage.delete(`s:${token}`);

                return jsonResponse(404, { error: { code: "EXPIRED", message: "session expired" } });
            }

            return jsonResponse(200, { token, ...record });
        }

        if (request.method === "DELETE" && url.pathname === "/revoke") {
            const token = url.searchParams.get("token");

            if (!token) {
                return jsonResponse(400, { error: { code: "INVALID_INPUT", message: "token required" } });
            }

            await this.state.storage.delete(`s:${token}`);

            return jsonResponse(200, { ok: true });
        }

        return jsonResponse(404, { error: { code: "NOT_FOUND", message: "no such session route" } });
    }
}
