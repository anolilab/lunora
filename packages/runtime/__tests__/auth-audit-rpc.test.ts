import { describe, expect, it, vi } from "vitest";

import type { AuthAuditEntry, AuthAuditReader, ExecutionContextLike } from "../src/create-worker";
import { createWorker, GET_AUTH_AUDIT_LOG_OP } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

// A shard namespace that throws if reached — the auth-audit RPC is served at the
// worker (D1), so a correct implementation must NEVER forward it to a shard.
const failingShard: ShardNamespaceLike = {
    get: () => {
        return {
            fetch: async () => {
                throw new Error("auth-audit RPC must not reach a shard");
            },
        };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

const ADMIN_TOKEN = "audit-admin";

const ENTRIES: AuthAuditEntry[] = [
    { actorEmail: "a@example.com", actorId: "u1", event: "sign-in", ip: "203.0.113.7", outcome: "success", seq: 2, ts: 1_700_000_002_000, userAgent: "curl/8" },
    { actorId: "u2", event: "password-change", outcome: "failure", seq: 1, ts: 1_700_000_001_000 },
];

/** A reader spy that records the query it was called with and returns fixed entries. */
const readerSpy = (entries: AuthAuditEntry[] = ENTRIES): AuthAuditReader => {
    return { read: vi.fn<AuthAuditReader["read"]>(async () => entries) };
};

/** POST the auth-audit RPC envelope, optionally with the admin bearer. */
const rpc = (args: Record<string, unknown> = {}, admin = true): Request =>
    new Request("https://app.example/_lunora/rpc", {
        body: JSON.stringify({ args, functionPath: GET_AUTH_AUDIT_LOG_OP }),
        headers: admin ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {},
        method: "POST",
    });

describe("createWorker — getAuthAuditLog admin RPC", () => {
    it("rejects a non-admin caller with 403 ADMIN_FORBIDDEN (default-closed)", async () => {
        expect.assertions(3);

        const reader = readerSpy();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAuditReader: reader, shardDO: failingShard });

        const response = await worker.fetch(rpc({}, false), {}, fakeContext);

        expect(response.status).toBe(403);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("ADMIN_FORBIDDEN");
        // Gate runs before the read — the reader is never consulted for a non-admin.
        expect(reader.read).not.toHaveBeenCalled();
    });

    it("reports AUTH_AUDIT_NOT_CONFIGURED (400) when no reader is wired", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: failingShard });

        const response = await worker.fetch(rpc(), {}, fakeContext);

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe("AUTH_AUDIT_NOT_CONFIGURED");
    });

    it("returns the reader's entries for an admin caller", async () => {
        expect.assertions(2);

        const reader = readerSpy();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAuditReader: reader, shardDO: failingShard });

        const response = await worker.fetch(rpc(), {}, fakeContext);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ entries: ENTRIES });
    });

    it("passes actor/event/sinceSeq/limit filters through to the reader", async () => {
        expect.assertions(1);

        const reader = readerSpy();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAuditReader: reader, shardDO: failingShard });

        await worker.fetch(rpc({ actorId: "u1", event: "sign-in", limit: 50, sinceSeq: 10 }), {}, fakeContext);

        expect(reader.read).toHaveBeenCalledWith({ actorId: "u1", event: "sign-in", limit: 50, sinceSeq: 10 });
    });

    it("drops empty/invalid filter args instead of forwarding them", async () => {
        expect.assertions(1);

        const reader = readerSpy();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, authAuditReader: reader, shardDO: failingShard });

        // Empty string and a negative seq are not valid filters — the handler must
        // omit them so the reader falls back to its defaults.
        await worker.fetch(rpc({ actorId: "", event: "sign-up", sinceSeq: -5 }), {}, fakeContext);

        expect(reader.read).toHaveBeenCalledWith({ event: "sign-up" });
    });

    it("returns a generic AUTH_AUDIT_READ_FAILED (500) without leaking a backend error", async () => {
        expect.assertions(2);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            authAuditReader: {
                read: async () => {
                    throw new Error("D1_SCHEMA_LEAK: table __lunora_auth_audit__ missing column");
                },
            },
            shardDO: failingShard,
        });

        const response = await worker.fetch(rpc(), {}, fakeContext);

        expect(response.status).toBe(500);

        const body: { error: { code: string; message: string } } = await response.json();

        expect(body.error.code).toBe("AUTH_AUDIT_READ_FAILED");
    });
});
