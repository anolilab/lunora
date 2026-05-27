/**
 * In-process fake for the `SESSION` DurableObjectNamespace binding.
 *
 * The real `SessionDO` (in `@cirrus/do`) persists session records keyed by
 * `s:${token}` inside the DO's KV storage. To keep auth tests fast and free
 * of cross-package coupling we mirror just that contract here:
 *
 *  - `idFromName(name)` returns the DO instance for that bucket name,
 *    creating it on demand. The spy lets tests assert the name we sharded on.
 *  - `getByName` is intentionally omitted so the auth package's
 *    `idFromName -> get` fallback path is exercised.
 *  - Each stub implements the same three endpoints SessionDO exposes:
 *    `POST /create`, `GET /get?token=`, `DELETE /revoke?token=`.
 */
import { vi } from "vitest";

import type { SessionNamespaceLike } from "../src/types.js";

interface SessionRecord {
    userId: string;
    createdAt: number;
    expiresAt: number;
}

interface FakeStub {
    name: string;
    storage: Map<string, SessionRecord>;
    fetch: (request: Request) => Promise<Response>;
}

export interface FakeSessionNamespace extends SessionNamespaceLike {
    instances: Map<string, FakeStub>;
    /** vitest mock for spying on which shard buckets were resolved. */
    idFromName: ReturnType<typeof vi.fn> & ((name: string) => unknown);
    get: (id: unknown) => FakeStub;
}

const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });

const createStub = (name: string): FakeStub => {
    const storage = new Map<string, SessionRecord>();
    const stub: FakeStub = {
        name,
        storage,
        async fetch(request) {
            const url = new URL(request.url);

            if (request.method === "POST" && url.pathname === "/create") {
                const body = (await request.json()) as { token: string; userId: string; ttlSeconds?: number };
                const ttl = body.ttlSeconds ?? 7 * 24 * 60 * 60;
                const now = Date.now();
                const record: SessionRecord = { userId: body.userId, createdAt: now, expiresAt: now + ttl * 1000 };

                storage.set(`s:${body.token}`, record);

                return json(201, { token: body.token, ...record });
            }

            if (request.method === "GET" && url.pathname === "/get") {
                const token = url.searchParams.get("token") ?? "";
                const record = storage.get(`s:${token}`);

                if (!record) {
                    return json(404, { error: { code: "NOT_FOUND" } });
                }

                if (record.expiresAt < Date.now()) {
                    storage.delete(`s:${token}`);

                    return json(404, { error: { code: "EXPIRED" } });
                }

                return json(200, { token, ...record });
            }

            if (request.method === "DELETE" && url.pathname === "/revoke") {
                const token = url.searchParams.get("token") ?? "";

                storage.delete(`s:${token}`);

                return json(200, { ok: true });
            }

            return json(404, { error: { code: "NOT_FOUND" } });
        },
    };

    return stub;
};

export const createFakeSessionNamespace = (): FakeSessionNamespace => {
    const instances = new Map<string, FakeStub>();

    const idFromName = vi.fn((name: string) => {
        if (!instances.has(name)) {
            instances.set(name, createStub(name));
        }

        // Mimic the opaque `DurableObjectId` shape — tests should not
        // depend on the structure here, only on `idFromName` being called.
        return { __name: name };
    });

    const get = (id: unknown): FakeStub => {
        const name = (id as { __name?: string }).__name ?? "";
        const stub = instances.get(name);

        if (!stub) {
            throw new Error(`FakeSessionNamespace: no stub for id ${JSON.stringify(id)}`);
        }

        return stub;
    };

    return { instances, idFromName, get };
};
