/**
 * Durable Object that owns auth session state.
 *
 * `@lunora/auth` used to write sessions directly into D1 alongside user
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
 * GET    /get      header: `x-lunora-session-token: <token>`
 * DELETE /revoke   header: `x-lunora-session-token: <token>`
 *
 * Every request must additionally carry an `x-lunora-session-secret` header
 * whose value matches `env.SESSION_DO_SECRET`. The DO is reachable from any
 * worker bound to its namespace, so a shared secret is the only thing that
 * prevents a compromised or misbehaving worker from reading arbitrary
 * sessions — the binding alone is not an auth surface.
 *
 * The DO returns JSON bodies that `@lunora/auth` reshapes into its public
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
import type { ShardAlarms, ShardKvStore } from "@lunora/platform";
import { createShardAlarms, createShardKvStore } from "@lunora/platform-cloudflare";

import { constantTimeEqual } from "../../../shared/constant-time-equal";
import { jsonResponse } from "../../../shared/json-response";

/** Default TTL for new sessions (7 days), matching `@lunora/auth`. */
const SESSION_DO_TTL_DEFAULT: number = 7 * 24 * 60 * 60;

/** Hard ceiling on the requested TTL — 90 days. Longer sessions should ride on top via refresh. */
const SESSION_DO_TTL_MAX: number = 90 * 24 * 60 * 60;

/**
 * How often the GC alarm sweeps expired session records (daily). Lazy
 * expiry-on-read still applies; this only reclaims storage for sessions that are
 * never read again (e.g. an abandoned token), keeping residue bounded to ~1 day.
 */
const SESSION_GC_INTERVAL_MS: number = 24 * 60 * 60 * 1000;

/** Header used to authenticate the calling worker to the SessionDO. */
const SESSION_SECRET_HEADER = "x-lunora-session-do-secret";

/** Header used to carry the session token on `/get` and `/revoke`. */
const SESSION_TOKEN_HEADER = "x-lunora-session-token";

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
        // Alarm + list are used by the optional GC sweep. Declared optional so
        // the plain-object doubles in the unit tests (which only exercise
        // create/get/revoke) still satisfy the structural shape — the alarm path
        // is a no-op when the runtime/double doesn't provide them.
        getAlarm?: () => Promise<number | null>;
        list?: <T = unknown>(options?: { prefix?: string }) => Promise<Map<string, T>>;
        put: (key: string, value: unknown) => Promise<void>;
        // `number | Date` to match the runtime `DurableObjectStorage.setAlarm`
        // and the platform `ShardAlarms.set`; SessionDO only ever passes a number.
        setAlarm?: (scheduledTime: number | Date) => Promise<void>;
    };
}

/**
 * Env shape SessionDO reads. The runtime always carries the bindings the
 * Worker declares; we only enumerate the ones this DO depends on.
 *
 * - `SESSION_DO_SECRET` — shared secret every caller must present in the
 * `x-lunora-session-do-secret` header. Provisioned via `wrangler secret`.
 * When unset, every request is rejected with 401 (closed by default).
 */
interface SessionDOEnv {
    SESSION_DO_SECRET?: string;
}

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
 * @returns the resolved TTL in seconds, or `undefined` for a malformed or out-of-range input
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

/**
 * @returns the token string when valid, or `undefined` when the value is not a string or violates the length bounds
 */
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
 * `import { SessionDO } from "@lunora/do";`
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

    /**
     * Durable record store, bound to the `@lunora/platform` contract rather
     * than reached through `state.storage` directly. `SessionDO` keeps plain
     * session records — ordered key lookup and a prefix sweep — which is the KV
     * surface, not the reactive engine's `ShardHost`. Binding it here is what
     * lets the same session logic run on a non-Cloudflare host that supplies a
     * `ShardKvStore`.
     */
    private readonly kv: ShardKvStore;

    /** GC-sweep alarm, via the shared platform alarm contract. */
    private readonly alarms: ShardAlarms;

    public constructor(state: SessionDOState, env: unknown) {
        this.state = state;
        this.env = env;
        this.kv = createShardKvStore(state.storage);
        this.alarms = createShardAlarms(state.storage);
    }

    public async fetch(request: Request): Promise<Response> {
        const env = (this.env ?? {}) as SessionDOEnv;

        if (!isAuthorized(request, env)) {
            return jsonResponse({ error: { code: "UNAUTHORIZED", message: "missing or invalid SessionDO secret" } }, 401);
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

        return jsonResponse({ error: { code: "NOT_FOUND", message: "no such session route" } }, 404);
    }

    /**
     * Sweep expired session records. Lazy expiry-on-read ({@link handleGet})
     * already keeps reads correct; this reclaims storage for sessions that are
     * never read again. Re-arms itself while any sessions remain so the DO goes
     * fully idle (no billable alarm) once it's empty.
     */
    public async alarm(): Promise<void> {
        // `list` is the one KV op that may be absent on the plain-object doubles
        // the unit tests pass (they exercise only create/get/revoke). Probe the
        // underlying storage before routing through the contract so the sweep
        // stays a no-op there rather than throwing.
        if (typeof this.state.storage.list !== "function") {
            return;
        }

        const now = Date.now();
        const entries = await this.kv.list<SessionRecord>({ prefix: "s:" });
        const expired: string[] = [];
        let remaining = 0;

        for (const [key, record] of entries) {
            if (record.expiresAt < now) {
                expired.push(key);
            } else {
                remaining += 1;
            }
        }

        for (const key of expired) {
            // eslint-disable-next-line no-await-in-loop -- bounded GC sweep; ShardKvStore.delete takes one key
            await this.kv.delete(key);
        }

        if (remaining > 0) {
            await this.alarms.set(now + SESSION_GC_INTERVAL_MS);
        }
    }

    private async handleCreate(request: Request): Promise<Response> {
        let body: { token?: unknown; ttlSeconds?: unknown; userId?: unknown };

        try {
            body = await request.json();
        } catch {
            return jsonResponse({ error: "invalid_request" }, 400);
        }

        const token = validateToken(body.token);

        if (token === undefined) {
            return jsonResponse({ error: "invalid_request" }, 400);
        }

        const { userId } = body;

        if (typeof userId !== "string" || userId.length === 0 || userId.length > MAX_USER_ID_LENGTH) {
            return jsonResponse({ error: "invalid_request" }, 400);
        }

        const ttlSeconds = resolveTtlSeconds(body.ttlSeconds);

        if (ttlSeconds === undefined) {
            return jsonResponse({ error: "invalid_request" }, 400);
        }

        const now = Date.now();
        const record: SessionRecord = { createdAt: now, expiresAt: now + ttlSeconds * 1000, userId };

        await this.kv.put(`s:${token}`, record);
        await this.armGcAlarm();

        return jsonResponse({ token, ...record }, 201);
    }

    /**
     * Ensure a GC alarm is pending. Only sets one when none is currently
     * scheduled, so a burst of `create`s arms a single recurring sweep rather
     * than thrashing the alarm. A no-op when the runtime/double doesn't expose
     * the alarm API.
     */
    private async armGcAlarm(): Promise<void> {
        // On doubles without the alarm API, `get` reads `null` and `set` is a
        // no-op, so the whole method degrades to nothing — the same outcome as
        // the previous explicit capability guard.
        const existing = await this.alarms.get();

        if (existing === null) {
            await this.alarms.set(Date.now() + SESSION_GC_INTERVAL_MS);
        }
    }

    private async handleGet(request: Request): Promise<Response> {
        const token = request.headers.get(SESSION_TOKEN_HEADER);

        if (!token) {
            return jsonResponse({ error: { code: "INVALID_INPUT", message: "token required" } }, 400);
        }

        const record = await this.kv.get<SessionRecord>(`s:${token}`);

        if (!record) {
            return jsonResponse({ error: { code: "NOT_FOUND", message: "session not found" } }, 404);
        }

        // Expire lazily on read for correctness; the GC alarm ({@link alarm})
        // separately reclaims storage for sessions that are never read again.
        if (record.expiresAt < Date.now()) {
            await this.kv.delete(`s:${token}`);

            return jsonResponse({ error: { code: "EXPIRED", message: "session expired" } }, 404);
        }

        return jsonResponse({ token, ...record }, 200);
    }

    private async handleRevoke(request: Request): Promise<Response> {
        const token = request.headers.get(SESSION_TOKEN_HEADER);

        if (!token) {
            return jsonResponse({ error: { code: "INVALID_INPUT", message: "token required" } }, 400);
        }

        await this.kv.delete(`s:${token}`);

        return jsonResponse({ ok: true }, 200);
    }
}

export { SESSION_DO_TTL_DEFAULT, SESSION_DO_TTL_MAX, SessionDO };
export type { SessionRecord };
