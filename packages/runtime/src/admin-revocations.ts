/**
 * The worker's client for the admin revocation Durable Object: where a named
 * admin token's revocation is recorded so a point-in-time restore of the default
 * shard, which brings the token row back, cannot bring the token back with it.
 *
 * A revocation is keyed by the token's name and its `createdAt` (see
 * `AdminRevocationDO`). Calls carry the root admin token, the only credential
 * the store answers.
 */
import { ADMIN_REVOCATION_DO_NAME } from "../../../shared/admin-token";
import { LunoraError } from "./errors";
import type { ShardNamespaceLike } from "./resolve-shard";
import { resolveShard } from "./resolve-shard";

const BASE_URL = "https://admin-revocations.internal";

interface AdminRevocations {
    /** Record the revocation. Resolves only once it is durable; throws when it is not. */
    revoke: (name: string, createdAt: number) => Promise<void>;
    /** Every `createdAt` revoked for `name`. Throws when the store cannot answer: callers fail closed. */
    revokedAt: (name: string) => Promise<number[]>;
}

const createAdminRevocations = (namespace: ShardNamespaceLike, rootToken: () => string | undefined): AdminRevocations => {
    const send = async (path: string, init: { body?: string; method: "GET" | "POST" }): Promise<Response> => {
        const root = rootToken();

        if (root === undefined) {
            throw new LunoraError("named admin tokens require a configured LUNORA_ADMIN_TOKEN, which signs them", {
                code: "ADMIN_TOKEN_NOT_CONFIGURED",
                status: 400,
            });
        }

        // A stub is resolved per call: workerd refuses I/O on a stub created during another request.
        const response = await resolveShard(namespace, ADMIN_REVOCATION_DO_NAME).fetch(
            new Request(`${BASE_URL}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${root}`, "content-type": "application/json" },
            }),
        );

        if (!response.ok) {
            throw new LunoraError(`admin revocation store answered ${String(response.status)}`, { code: "SHARD_UNAVAILABLE", status: 503 });
        }

        return response;
    };

    return {
        revoke: async (name, createdAt) => {
            await send("/revoke", { body: JSON.stringify({ createdAt, name }), method: "POST" });
        },
        revokedAt: async (name) => {
            const response = await send(`/list?name=${encodeURIComponent(name)}`, { method: "GET" });
            const body: unknown = await response.json();
            const revoked = (body as null | { revoked?: unknown })?.revoked;

            if (!Array.isArray(revoked) || !revoked.every((value) => typeof value === "number")) {
                throw new LunoraError("admin revocation store answered garbage", { code: "SHARD_UNAVAILABLE", status: 503 });
            }

            return revoked;
        },
    };
};

export { createAdminRevocations };
export type { AdminRevocations };
