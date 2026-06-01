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
 * `await env.SESSION.get(env.SESSION.idFromName(prefix)).fetch(...)`
 *
 * with one of:
 *
 * POST   /create   body: { token, userId, ttlSeconds }
 * GET    /get      header: `x-cirrus-session-token: &lt;token>`
 * DELETE /revoke   header: `x-cirrus-session-token: &lt;token>`
 *
 * Every request must additionally carry an `x-cirrus-session-secret` header
 * whose value matches `env.SESSION_DO_SECRET`. The DO is reachable from any
 * worker bound to its namespace, so a shared secret is the only thing that
 * prevents a compromised or misbehaving worker from reading arbitrary
 * sessions — the binding alone is not an auth surface.
 *
 * The DO returns JSON bodies that `@cirrus/auth` reshapes into its public
 * `AuthSession` type. Keep the surface narrow — anything more elaborate
 * should ride on top via a wrapper, not by widening this contract.
 *
 * # Subclassing
 *
 * Apps subclass `SessionDO` (or use the codegen subclass) and register the
 * subclass in `wrangler.jsonc` as `SESSION`. The platform DO binding requires
 * a concrete `DurableObject` class today; the structural state shape used by
 * the unit tests is preserved so plain-object doubles still work.
 */

/** Default TTL for new sessions (7 days), matching `@cirrus/auth`. */
const SESSION_DO_TTL_DEFAULT: number = 7 * 24 * 60 * 60;

/** Hard ceiling on the requested TTL — 90 days. Longer sessions should ride on top via refresh. */
const SESSION_DO_TTL_MAX: number = 90 * 24 * 60 * 60;

/** Header used to authenticate the calling worker to the SessionDO. */
const SESSION_SECRET_HEADER = "x-cirrus-session-do-secret";

/** Header used to carry the session token on `/get` and `/revoke`. */
const SESSION_TOKEN_HEADER = "x-cirrus-session-token";

/** Allowed character class for session tokens — base64url-ish so cookies stay clean. */
const SESSION_TOKEN_PATTERN = /^[\w-]+$/;

const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 256;
const MAX_USER_ID_LENGTH = 256;

/**
 * Persisted session payload. Stored under `s:${token}` so the token never
 * leaves the cookie — we only ever look up by exact match.
 */
interface SessionRecord {
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
        put: (key: string, value: unknown) => Promise<void>;
    };
}

/**
 * Env shape SessionDO reads. The runtime always carries the bindings the
 * Worker declares; we only enumerate the ones this DO depends on.
 *
 * - `SESSION_DO_SECRET` — shared secret every caller must present in the
 * `x-cirrus-session-do-secret` header. Provisioned via `wrangler secret`.
 * When unset, every request is rejected with 401 (closed by default).
 */
interface SessionDOEnv {
    SESSION_DO_SECRET?: string;
}

const jsonResponse = (status: number, body: unknown): Response =>
    Response.json(body, {
        headers: { "content-type": "application/json" },
        status,
    });

/**
 * Length-independent constant-time string compare. Mirrors the helper in
 * `packages/do/src/shard-do.ts` and `packages/runtime/src/create-worker.ts` —
 * duplicated rather than imported to keep SessionDO's surface free of
 * package-internal couplings.
 */
const constantTimeEqual = (a: string, b: string): boolean => {
    const max = Math.max(a.length, b.length);
    // eslint-disable-next-line no-bitwise -- constant-time compare folds length + every code-unit delta into one accumulator
    let diff = a.length ^ b.length;

    for (let index = 0; index < max; index += 1) {
        // eslint-disable-next-line unicorn/prefer-code-point -- compare per UTF-16 code unit so timing stays independent of surrogate boundaries
        const charA = index < a.length ? a.charCodeAt(index) : 0;
        // eslint-disable-next-line unicorn/prefer-code-point -- compare per UTF-16 code unit so timing stays independent of surrogate boundaries
        const charB = index < b.length ? b.charCodeAt(index) : 0;

        // eslint-disable-next-line no-bitwise -- accumulate per-code-unit difference without branching to keep the compare constant-time
        diff |= charA ^ charB;
    }

    return diff === 0;
};

const isAuthorized = (request: Request, env: SessionDOEnv): boolean => {
    const expected = env.SESSION_DO_SECRET;

    if (typeof expected !== "string" || expected.length === 0) {
        return false;
    }

    const supplied = request.headers.get(SESSION_SECRET_HEADER);

    if (typeof supplied !== "string" || supplied.length === 0) {
        return false;
    }

    return constantTimeEqual(expected, supplied);
};

/**
 * Resolve the requested TTL. A missing/`null` field accepts the default; a
 * number must sit in the legal window. Any other shape — or an out-of-range
 * number — yields `undefined` so the caller rejects it (no silent default for
 * malformed input like strings or negatives).
 */
const resolveTtlSeconds = (raw: unknown): number | undefined => {
    let ttlSeconds: number;

    if (raw === undefined || raw === null) {
        ttlSeconds = SESSION_DO_TTL_DEFAULT;
    } else if (typeof raw === "number") {
        ttlSeconds = raw;
    } else {
        return undefined;
    }

    if (!Number.isFinite(ttlSeconds) || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > SESSION_DO_TTL_MAX) {
        return undefined;
    }

    return ttlSeconds;
};

const validateToken = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
        return undefined;
    }

    if (value.length < MIN_TOKEN_LENGTH || value.length > MAX_TOKEN_LENGTH) {
        return undefined;
    }

    if (!SESSION_TOKEN_PATTERN.test(value)) {
        return undefined;
    }

    return value;
};

/**
 * Concrete (not abstract) DO class. Subclass and register the subclass as
 * the `SESSION` binding in `wrangler.jsonc`:
 *
 * `import { SessionDO } from "@cirrus/do";`
 *
 * `export class AppSessionDO extends SessionDO {}`
 *
 * The platform DO binding requires a concrete class today, hence the
 * subclass step. The structural state/env shapes are preserved so unit
 * tests can pass plain-object doubles without depending on `cloudflare:workers`.
 */
class SessionDO {
    protected state: SessionDOState;

    protected env: unknown;

    public constructor(state: SessionDOState, env: unknown) {
        this.state = state;
        this.env = env;
    }

    public async fetch(request: Request): Promise<Response> {
        const env = (this.env ?? {}) as SessionDOEnv;

        if (!isAuthorized(request, env)) {
            return jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "missing or invalid SessionDO secret" } });
        }

        const url = new URL(request.url);

        if (request.method === "POST" && url.pathname === "/create") {
            return this.handleCreate(request);
        }

        if (request.method === "GET" && url.pathname === "/get") {
            return this.handleGet(request);
        }

        if (request.method === "DELETE" && url.pathname === "/revoke") {
            return this.handleRevoke(request);
        }

        return jsonResponse(404, { error: { code: "NOT_FOUND", message: "no such session route" } });
    }

    private async handleCreate(request: Request): Promise<Response> {
        let body: { token?: unknown; ttlSeconds?: unknown; userId?: unknown };

        try {
            body = await request.json();
        } catch {
            return jsonResponse(400, { error: "invalid_request" });
        }

        const token = validateToken(body.token);

        if (token === undefined) {
            return jsonResponse(400, { error: "invalid_request" });
        }

        const { userId } = body;

        if (typeof userId !== "string" || userId.length === 0 || userId.length > MAX_USER_ID_LENGTH) {
            return jsonResponse(400, { error: "invalid_request" });
        }

        const ttlSeconds = resolveTtlSeconds(body.ttlSeconds);

        if (ttlSeconds === undefined) {
            return jsonResponse(400, { error: "invalid_request" });
        }

        const now = Date.now();
        const record: SessionRecord = { createdAt: now, expiresAt: now + ttlSeconds * 1000, userId };

        await this.state.storage.put(`s:${token}`, record);

        return jsonResponse(201, { token, ...record });
    }

    private async handleGet(request: Request): Promise<Response> {
        const token = request.headers.get(SESSION_TOKEN_HEADER);

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

    private async handleRevoke(request: Request): Promise<Response> {
        const token = request.headers.get(SESSION_TOKEN_HEADER);

        if (!token) {
            return jsonResponse(400, { error: { code: "INVALID_INPUT", message: "token required" } });
        }

        await this.state.storage.delete(`s:${token}`);

        return jsonResponse(200, { ok: true });
    }
}

export { SESSION_DO_TTL_DEFAULT, SESSION_DO_TTL_MAX, SessionDO };
export type { SessionRecord };
