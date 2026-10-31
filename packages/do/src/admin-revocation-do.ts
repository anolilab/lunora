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
 * Routes: `POST /revoke` with `{ name, createdAt }`, and `GET /list?name=` answering
 * `{ revoked }`, the `createdAt`s revoked for that name.
 */

import { constantTimeEqual } from "../../../shared/constant-time-equal";
import { jsonResponse } from "../../../shared/json-response";
import { readBodyTextCapped } from "../../../shared/read-body-text-capped";

const ENTRY_PREFIX = "r:";

/** Separator between name and `createdAt` in a storage key. NUL cannot appear in a valid token name. */
const KEY_SEPARATOR = "\u0000";

const BEARER_RE = /^bearer\s+(\S+)\s*$/iu;

const MAX_REQUEST_BYTES = 4 * 1024;

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

interface AdminRevocationDOState {
    storage: {
        list: <T = unknown>(options: { prefix: string }) => Promise<Map<string, T>>;
        put: (key: string, value: unknown) => Promise<void>;
    };
}

const entryKey = (name: string, createdAt: number): string => `${ENTRY_PREFIX}${name}${KEY_SEPARATOR}${String(createdAt)}`;

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

        if (request.method === "GET" && url.pathname === "/list") {
            return this.list(url.searchParams.get("name"));
        }

        return refusal("NOT_FOUND", `unknown admin-revocation route ${request.method} ${url.pathname}`, 404);
    }

    private async list(name: null | string): Promise<Response> {
        if (name === null || !NAME_RE.test(name)) {
            return refusal("BAD_REQUEST", "`name` must be a valid admin token name", 400);
        }

        const stored = await this.state.storage.list<number>({ prefix: `${ENTRY_PREFIX}${name}${KEY_SEPARATOR}` });

        return jsonResponse({ revoked: [...stored.values()] }, 200);
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

        // Awaited: the caller is told "revoked" only once the write has landed.
        await this.state.storage.put(entryKey(name, createdAt), createdAt);

        return jsonResponse({ revoked: true }, 200);
    }
}

export { AdminRevocationDO };

export { ADMIN_REVOCATION_DO_NAME } from "../../../shared/admin-token";
