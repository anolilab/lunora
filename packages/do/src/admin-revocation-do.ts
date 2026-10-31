/**
 * Durable Object that remembers which named admin tokens were revoked, outside
 * any store a point-in-time restore can rewind.
 *
 * Token rows live in the default shard's SQLite, so restoring that shard to a
 * moment before a revocation brings the revoked row back. A revocation recorded
 * here is untouched by that restore, and the worker refuses a token this DO
 * names even when the shard still lists it.
 *
 * A revocation is keyed by the token's name AND its `createdAt`, the identity of
 * one issued credential: a restored row carries the same pair and stays refused,
 * while a token created later under the same name has a new `createdAt`.
 *
 * Not a `ShardDO`: it has no `__lunora_admin__` surface, so no admin RPC, SQL
 * console, export or restore can read or change it. The one door is this
 * `fetch`, which answers only the root `LUNORA_ADMIN_TOKEN`, compared in
 * constant time. A DO without that token refuses everything.
 *
 * Routes: `POST /revoke` with `{ name, createdAt }`; `GET /revoked?name=&createdAt=` answering
 * `{ revoked }` for that one issuance; `GET /latest?name=` answering `{ latest }`, the highest
 * `createdAt` revoked for the name or `null`. Every read is a direct `get` of an exact key and the
 * latest is kept in a key of its own, so no answer depends on a storage listing being complete, however
 * many revocations a name has accumulated.
 */

import { constantTimeEqual } from "../../../shared/constant-time-equal";
import { jsonResponse } from "../../../shared/json-response";
import { readBodyTextCapped } from "../../../shared/read-body-text-capped";

const ENTRY_PREFIX = "r:";

const LATEST_PREFIX = "m:";

/** Separator between name and `createdAt` in a storage key. NUL cannot appear in a valid token name. */
const KEY_SEPARATOR = "\u0000";

const BEARER_RE = /^bearer\s+(\S+)\s*$/iu;

const MAX_REQUEST_BYTES = 4 * 1024;

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

interface AdminRevocationDOState {
    storage: {
        get: <T = unknown>(key: string) => Promise<T | undefined>;
        /** Several entries in one call are written atomically. */
        put: (entries: Record<string, unknown>) => Promise<void>;
    };
}

const entryKey = (name: string, createdAt: number): string => `${ENTRY_PREFIX}${name}${KEY_SEPARATOR}${String(createdAt)}`;

/** The key holding the highest `createdAt` revoked for a name. */
const latestKey = (name: string): string => `${LATEST_PREFIX}${name}`;

const refusal = (code: string, message: string, status: number): Response => jsonResponse({ error: { code, message } }, status);

class AdminRevocationDO {
    private readonly env: unknown;

    private readonly state: AdminRevocationDOState;

    public constructor(state: AdminRevocationDOState, env: unknown) {
        this.state = state;
        this.env = env;
    }

    public async fetch(request: Request): Promise<Response> {
        const root = (this.env as undefined | { LUNORA_ADMIN_TOKEN?: string })?.LUNORA_ADMIN_TOKEN;
        const supplied = BEARER_RE.exec(request.headers.get("authorization") ?? "")?.[1];

        if (root === undefined || root === "" || supplied === undefined || !constantTimeEqual(supplied, root)) {
            return refusal("ADMIN_FORBIDDEN", "the admin revocation store answers only the root admin token", 403);
        }

        const url = new URL(request.url);

        if (request.method === "POST" && url.pathname === "/revoke") {
            return this.revoke(request);
        }

        if (request.method === "GET" && url.pathname === "/revoked") {
            return this.isRevoked(url.searchParams.get("name"), url.searchParams.get("createdAt"));
        }

        if (request.method === "GET" && url.pathname === "/latest") {
            return this.latest(url.searchParams.get("name"));
        }

        return refusal("NOT_FOUND", `unknown admin-revocation route ${request.method} ${url.pathname}`, 404);
    }

    private async isRevoked(name: null | string, createdAt: null | string): Promise<Response> {
        const at = createdAt === null ? Number.NaN : Number(createdAt);

        if (name === null || !NAME_RE.test(name) || !Number.isSafeInteger(at)) {
            return refusal("BAD_REQUEST", "expected ?name=<admin token name>&createdAt=<epoch ms>", 400);
        }

        return jsonResponse({ revoked: (await this.state.storage.get(entryKey(name, at))) !== undefined }, 200);
    }

    private async latest(name: null | string): Promise<Response> {
        if (name === null || !NAME_RE.test(name)) {
            return refusal("BAD_REQUEST", "`name` must be a valid admin token name", 400);
        }

        const latest = await this.state.storage.get<number>(latestKey(name));

        // eslint-disable-next-line unicorn/no-null -- the JSON wire value for "none"; an absent key would read the same as a malformed answer
        return jsonResponse({ latest: latest ?? null }, 200);
    }

    private async revoke(request: Request): Promise<Response> {
        const raw = await readBodyTextCapped(request, MAX_REQUEST_BYTES);
        let body: { createdAt?: unknown; name?: unknown } = {};

        try {
            body = raw === null ? {} : (JSON.parse(raw) as typeof body);
        } catch {
            // Falls through to the validation below.
        }

        const { createdAt, name } = body;

        if (typeof name !== "string" || !NAME_RE.test(name) || typeof createdAt !== "number" || !Number.isSafeInteger(createdAt)) {
            return refusal("BAD_REQUEST", "expected { name: <admin token name>, createdAt: <epoch ms> }", 400);
        }

        const latest = await this.state.storage.get<number>(latestKey(name));

        // One atomic write of the revocation and the name's running maximum: the caller is told "revoked"
        // only once both have landed, and a re-create can always be placed past the newest revoked issuance.
        await this.state.storage.put({ [entryKey(name, createdAt)]: createdAt, [latestKey(name)]: Math.max(latest ?? createdAt, createdAt) });

        return jsonResponse({ revoked: true }, 200);
    }
}

export { AdminRevocationDO };

export { ADMIN_REVOCATION_DO_NAME } from "../../../shared/admin-token";
