import { afterEach, describe, expect, it, vi } from "vitest";

import { ADMIN_SIGNAL_HEADER, verifyAdminSignal } from "../../../shared/admin-token";
import type { AdminTokenLookup } from "../src/admin-token-verifier";
import { ADMIN_TOKEN_CACHE_TTL_MS, ADMIN_TOKEN_REFUSAL_TTL_MS, ADMIN_TOKEN_UNKNOWN_NAME_BURST, createAdminTokenVerifier } from "../src/admin-token-verifier";
import type { ExecutionContextLike, FunctionRegistryLike } from "../src/create-worker";
import { createWorker as createBareWorker } from "../src/create-worker";
import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const ROOT = "root-admin-token";
const ORIGIN = "https://app.example";
const TOKENS = `${ORIGIN}/_lunora/admin/tokens`;
const REGISTRY: FunctionRegistryLike = { "messages:list": { kind: "query" } };

/**
 * The admin revocation Durable Object: serves the same two routes, answers only the root bearer,
 * and can be made to refuse writes. Shared by the worker wrapper below so a test can inspect it.
 */
const revocationStore = { failReads: false, failWrites: false, revoked: new Map<string, number[]>() };

const fakeRevocations = (): ShardNamespaceLike => {
    const fetch = async (request: Request): Promise<Response> => {
        if (request.headers.get("authorization") !== `Bearer ${ROOT}`) {
            return Response.json({ error: { code: "ADMIN_FORBIDDEN" } }, { status: 403 });
        }

        const url = new URL(request.url);

        if (url.pathname === "/revoke") {
            if (revocationStore.failWrites) {
                return new Response("down", { status: 503 });
            }

            const { createdAt, name } = await request.json<{ createdAt: number; name: string }>();

            revocationStore.revoked.set(name, [...(revocationStore.revoked.get(name) ?? []), createdAt]);

            return Response.json({ revoked: true });
        }

        if (revocationStore.failReads) {
            return new Response("down", { status: 503 });
        }

        return Response.json({ revoked: revocationStore.revoked.get(url.searchParams.get("name") ?? "") ?? [] });
    };

    return {
        get: () => {
            return { fetch };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };
};

/** `createWorker` with the revocation store every app gets from codegen already bound. */
const createWorker = (options: Parameters<typeof createBareWorker>[0]): ReturnType<typeof createBareWorker> =>
    createBareWorker({ adminRevocations: fakeRevocations(), ...options });

const fakeContext: ExecutionContextLike = { passThroughOnException: () => undefined, waitUntil: () => undefined };

interface SeenRequest {
    body: string;
    headers: Record<string, string>;
}

/**
 * A shard namespace that serves the token-store ops from a map (root bearer
 * only, as the real shard does) and records every request it receives, so a
 * test can assert what crossed the worker-to-shard boundary.
 */
interface ShardHooks {
    down?: boolean;
    /** Deleting a token row fails, after the revocation was already recorded. */
    failRevoke?: boolean;
    /** Runs when a non-token admin op reaches a shard, before it is answered. */
    onAdminOp?: (functionPath: string) => Promise<void>;
}

/** The createdAt a create carried, or a fixed one when it carried none. */
const issuedAt = (value: unknown): number => (typeof value === "number" ? value : 1);

const fakeShards = (
    hooks?: ShardHooks,
): { namespace: ShardNamespaceLike; seen: SeenRequest[]; store: Map<string, { createdAt: number; digest: string; expiresAt?: number }> } => {
    // Every test builds its shards first, so this is where the revocation store starts clean.
    revocationStore.failReads = false;
    revocationStore.failWrites = false;
    revocationStore.revoked.clear();

    const store = new Map<string, { createdAt: number; digest: string; expiresAt?: number }>();
    const seen: SeenRequest[] = [];
    const reply = (result: unknown): Response => Response.json({ result });

    const fetch = async (request: Request): Promise<Response> => {
        const body = await request.text();

        seen.push({ body, headers: Object.fromEntries(request.headers) });

        if (body === "") {
            return new Response("upgrade");
        }

        const { args = {}, functionPath } = JSON.parse(body) as { args?: Record<string, number | string>; functionPath: string };

        if (!functionPath.endsWith("AdminToken") && !functionPath.endsWith("AdminTokens")) {
            await hooks?.onAdminOp?.(functionPath);

            return reply({ ok: "admin op served" });
        }

        if (hooks?.down === true) {
            return new Response("shard unavailable", { status: 503 });
        }

        if (request.headers.get("authorization") !== `Bearer ${ROOT}`) {
            return Response.json({ error: { code: "ADMIN_FORBIDDEN", message: "no" } }, { status: 403 });
        }

        switch (functionPath) {
            case "__lunora_admin__:createAdminToken": {
                store.set(String(args.name), {
                    createdAt: issuedAt(args.createdAt),
                    digest: String(args.digest),
                    ...(typeof args.expiresAt === "number" ? { expiresAt: args.expiresAt } : {}),
                });

                return reply({ createdAt: issuedAt(args.createdAt), name: args.name });
            }
            case "__lunora_admin__:listAdminTokens": {
                return reply({
                    tokens: [...store.keys()].map((name) => {
                        return { createdAt: store.get(name)?.createdAt ?? 1, name };
                    }),
                });
            }
            case "__lunora_admin__:revokeAdminToken": {
                if (hooks?.failRevoke === true) {
                    return new Response("shard unavailable", { status: 503 });
                }

                // Honours createdAt like the real shard: only the named issuance goes.
                const stored = store.get(String(args.name));

                return reply({ revoked: stored !== undefined && stored.createdAt === args.createdAt && store.delete(String(args.name)) });
            }
            default: {
                const stored = store.get(String(args.name));

                return reply(
                    stored !== undefined && stored.digest === args.digest
                        ? { createdAt: stored.createdAt, expiresAt: stored.expiresAt, ok: true }
                        : { known: stored !== undefined, ok: false },
                );
            }
        }
    };

    return {
        namespace: {
            get: () => {
                return { fetch };
            },
            idFromName: (name) => {
                return { __name: name };
            },
        },
        seen,
        store,
    };
};

const call = async (worker: ReturnType<typeof createWorker>, url: string, bearer: string | undefined, init: RequestInit = {}): Promise<Response> =>
    worker.fetch(
        new Request(url, { ...init, headers: { ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }), "content-type": "application/json" } }),
        {},
        fakeContext,
    );

const status = async (pending: Promise<Response>): Promise<number> => {
    const response = await pending;

    return response.status;
};

const errorCodeOf = async (pending: Promise<Response>): Promise<string | undefined> => {
    const response = await pending;
    const body = await response.json<{ error?: { code?: string } }>();

    return body.error?.code;
};

const setup = async (): Promise<{ seen: SeenRequest[]; token: string; worker: ReturnType<typeof createWorker> }> => {
    const { namespace, seen } = fakeShards();
    const worker = createWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });
    const created = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
    const { token } = await created.json<{ token: string }>();

    return { seen, token, worker };
};

describe("a revocation that outlives a restore of the token store", () => {
    it("keeps a token refused after its row is brought back", async () => {
        expect.assertions(4);

        const { namespace, seen, store } = fakeShards();
        const worker = createWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });
        const created = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        const { token } = await created.json<{ token: string }>();
        const row = store.get("ci");
        const rpc = { body: JSON.stringify({ args: {}, functionPath: "__lunora_admin__:listTables" }), method: "POST" };
        const signalFor = async (target: ReturnType<typeof createWorker>): Promise<string | undefined> => {
            await call(target, `${ORIGIN}/_lunora/rpc`, token, rpc);

            return seen.findLast((request) => request.body.includes("listTables"))?.headers[ADMIN_SIGNAL_HEADER];
        };

        await expect(signalFor(worker)).resolves.toBeDefined();

        const revoked = await call(worker, `${TOKENS}?name=ci`, ROOT, { method: "DELETE" });

        expect(revoked.status).toBe(200);

        // A point-in-time restore of the default shard: the row is back, exactly as it was.
        store.set("ci", row as NonNullable<typeof row>);

        // A fresh isolate, so nothing is cached from before the revoke.
        const fresh = createWorker({ adminRevocations: fakeRevocations(), adminToken: ROOT, functions: REGISTRY, shardDO: namespace });

        seen.length = 0;

        await expect(signalFor(fresh)).resolves.toBeUndefined();

        // The control: without the outside record the restored row would be honoured.
        revocationStore.revoked.clear();

        await expect(
            signalFor(createWorker({ adminRevocations: fakeRevocations(), adminToken: ROOT, functions: REGISTRY, shardDO: namespace })),
        ).resolves.toBeDefined();
    });

    it("lists a revoked token whose row a restore brought back as revoked, and still lets it be cleaned up", async () => {
        expect.assertions(4);

        const { namespace, store } = fakeShards();
        const worker = createWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });

        await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });

        const row = store.get("ci") as NonNullable<ReturnType<typeof store.get>>;

        await call(worker, `${TOKENS}?name=ci`, ROOT, { method: "DELETE" });
        // A point-in-time restore of the default shard: the row is back.
        store.set("ci", row);

        const listed = await call(worker, TOKENS, ROOT);

        // Not shown as live: it is flagged revoked, row still pending cleanup.
        await expect(listed.json()).resolves.toStrictEqual({ tokens: [{ createdAt: expect.any(Number), name: "ci", revoked: true }] });

        // The name is still held by the revived row, so revoking it again must clear it and free the name.
        await expect(status(call(worker, `${TOKENS}?name=ci`, ROOT, { method: "DELETE" }))).resolves.toBe(200);
        expect(store.has("ci")).toBe(false);
        await expect(status(call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" }))).resolves.toBe(201);
    });

    it("accepts a token re-created in the same millisecond as the one just revoked", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(5000);

        const { namespace, seen } = fakeShards();
        const worker = createWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });

        await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        await call(worker, `${TOKENS}?name=ci`, ROOT, { method: "DELETE" });

        const again = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        const { createdAt, token } = await again.json<{ createdAt: number; token: string }>();
        const rpc = { body: JSON.stringify({ args: {}, functionPath: "__lunora_admin__:listTables" }), method: "POST" };

        await call(worker, `${ORIGIN}/_lunora/rpc`, token, rpc);

        // The second issuance has its own identity even though the clock did not move.
        expect(createdAt).toBeGreaterThan(5000);
        expect(seen.findLast((request) => request.body.includes("listTables"))?.headers[ADMIN_SIGNAL_HEADER]).toBeDefined();

        vi.useRealTimers();
    });

    it("creates a token for a name with a very long revocation history", async () => {
        expect.assertions(1);

        const { namespace } = fakeShards();

        // Revocations are never deleted, so a name that has cycled many times lists them all.
        revocationStore.revoked.set(
            "ci",
            Array.from({ length: 300_000 }, (_unused, index) => index),
        );

        const worker = createWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });

        await expect(status(call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" }))).resolves.toBe(201);
    });

    it("admits a real token on a fresh isolate while a flood of invented names drains its budget", async () => {
        expect.assertions(1);

        const { namespace, seen } = fakeShards();
        const creator = createWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });
        const created = await call(creator, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        const { token } = await created.json<{ token: string }>();
        // Another isolate: it has never seen the token, nor the name.
        const fresh = createWorker({ adminRevocations: fakeRevocations(), adminToken: ROOT, functions: REGISTRY, shardDO: namespace });
        const rpc = { body: JSON.stringify({ args: {}, functionPath: "__lunora_admin__:listTables" }), method: "POST" };

        await Promise.all(
            Array.from({ length: 60 }, async (_unused, index) => call(fresh, `${ORIGIN}/_lunora/rpc`, `lnat.fake${String(index)}.${"z".repeat(43)}`, rpc)),
        );
        await call(fresh, `${ORIGIN}/_lunora/rpc`, token, rpc);

        expect(seen.findLast((request) => request.body.includes("listTables"))?.headers[ADMIN_SIGNAL_HEADER]).toBeDefined();
    });

    it("tells the shard which issuance to delete", async () => {
        expect.assertions(1);

        const { namespace, seen } = fakeShards();
        const worker = createWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });

        await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        await call(worker, `${TOKENS}?name=ci`, ROOT, { method: "DELETE" });

        const sent = seen.find((request) => request.body.includes("revokeAdminToken"));

        expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({ args: { createdAt: expect.any(Number), name: "ci" } });
    });

    it("does not refuse a token created later under a revoked name", async () => {
        expect.assertions(1);

        const { namespace, seen, store } = fakeShards();
        const worker = createWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });

        await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        await call(worker, `${TOKENS}?name=ci`, ROOT, { method: "DELETE" });

        const again = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        const { token } = await again.json<{ token: string }>();

        // The fake shard stamps every row createdAt 1, so give the new credential a later identity, as a real shard does.
        store.set("ci", { ...(store.get("ci") as NonNullable<ReturnType<typeof store.get>>), createdAt: 2 });

        const rpc = { body: JSON.stringify({ args: {}, functionPath: "__lunora_admin__:listTables" }), method: "POST" };

        await call(worker, `${ORIGIN}/_lunora/rpc`, token, rpc);

        expect(seen.findLast((request) => request.body.includes("listTables"))?.headers[ADMIN_SIGNAL_HEADER]).toBeDefined();
    });

    it("fails the revoke, and leaves the token row alone, when the outside write fails", async () => {
        expect.assertions(3);

        const { namespace, seen, store } = fakeShards();
        const worker = createWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });

        await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });

        revocationStore.failWrites = true;

        const revoked = await call(worker, `${TOKENS}?name=ci`, ROOT, { method: "DELETE" });

        expect(revoked.status).toBeGreaterThanOrEqual(500);
        expect(seen.some((request) => request.body.includes("revokeAdminToken"))).toBe(false);
        expect(store.has("ci")).toBe(true);
    });

    it("refuses a token while the outside store cannot answer, and accepts it again once it can", async () => {
        expect.assertions(2);

        const { namespace, seen } = fakeShards();
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const worker = createWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });
        const created = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        const { token } = await created.json<{ token: string }>();
        const rpc = { body: JSON.stringify({ args: {}, functionPath: "__lunora_admin__:listTables" }), method: "POST" };
        const signal = async (): Promise<string | undefined> => {
            await call(worker, `${ORIGIN}/_lunora/rpc`, token, rpc);

            return seen.findLast((request) => request.body.includes("listTables"))?.headers[ADMIN_SIGNAL_HEADER];
        };

        revocationStore.failReads = true;

        const during = await signal();

        revocationStore.failReads = false;
        errors.mockRestore();

        expect(during).toBeUndefined();
        await expect(signal()).resolves.toBeDefined();
    });

    it("records a revocation in the configured jurisdiction, never on the unpinned namespace", async () => {
        expect.assertions(2);

        const { namespace } = fakeShards();
        const pinned: string[] = [];
        const unpinned = fakeRevocations();
        const inEu: ShardNamespaceLike = {
            ...unpinned,
            get: (id, options) => {
                pinned.push("eu");

                return unpinned.get(id, options);
            },
        };
        const worker = createWorker({
            adminRevocations: {
                ...unpinned,
                get: () => {
                    return { fetch: async () => new Response("unpinned namespace used", { status: 500 }) };
                },
                jurisdiction: () => inEu,
            },
            adminToken: ROOT,
            functions: REGISTRY,
            jurisdiction: "eu",
            shardDO: { ...namespace, jurisdiction: () => namespace },
        });

        await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });

        const revoked = await call(worker, `${TOKENS}?name=ci`, ROOT, { method: "DELETE" });

        expect(revoked.status).toBe(200);
        expect(pinned).toContain("eu");
    });

    it("keeps a half-revoked token visible as revoked, so its name can be freed", async () => {
        expect.assertions(5);

        const hooks: ShardHooks = {};
        const { namespace, store } = fakeShards(hooks);
        const worker = createWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });

        await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });

        // The revocation lands in the outside store, then deleting the row fails.
        hooks.failRevoke = true;

        await expect(status(call(worker, `${TOKENS}?name=ci`, ROOT, { method: "DELETE" }))).resolves.toBeGreaterThanOrEqual(500);

        const listed = await call(worker, TOKENS, ROOT);

        await expect(listed.json()).resolves.toStrictEqual({ tokens: [{ createdAt: expect.any(Number), name: "ci", revoked: true }] });

        // Retried once the shard answers again: the row goes and the name is free.
        hooks.failRevoke = false;

        await expect(status(call(worker, `${TOKENS}?name=ci`, ROOT, { method: "DELETE" }))).resolves.toBe(200);
        expect(store.has("ci")).toBe(false);
        await expect(status(call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" }))).resolves.toBe(201);
    });

    it("says so when no revocation store is bound instead of listing tokens as live", async () => {
        expect.assertions(2);

        const { namespace } = fakeShards();
        const worker = createBareWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });
        const listed = await call(worker, TOKENS, ROOT);

        expect(listed.status).toBe(400);
        await expect(listed.json()).resolves.toMatchObject({ error: { code: "ADMIN_TOKEN_NOT_CONFIGURED" } });
    });

    it("refuses to create a token when no revocation store is bound", async () => {
        expect.assertions(1);

        const { namespace } = fakeShards();
        const worker = createBareWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });

        await expect(status(call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" }))).resolves.toBe(400);
    });
});

describe("named admin tokens", () => {
    it("creates a token whose secret the store never sees, and lists it without the secret", async () => {
        expect.assertions(4);

        const { seen, token, worker } = await setup();

        expect(token).toMatch(/^lnat\.ci\.[\w-]{43}$/u);

        const secret = token.split(".")[2] as string;

        expect(JSON.stringify(seen)).not.toContain(secret);

        const listed = await call(worker, TOKENS, ROOT);

        await expect(listed.json()).resolves.toStrictEqual({ tokens: [{ createdAt: expect.any(Number), name: "ci" }] });
        expect(listed.headers.get("cache-control")).toBe("no-store");
    });

    it("authorizes the admin plane with a named token and refuses unknown or malformed ones", async () => {
        expect.assertions(4);

        const { seen, token, worker } = await setup();

        await expect(status(call(worker, `${ORIGIN}/_lunora/admin/functions`, token))).resolves.toBe(200);
        await expect(status(call(worker, `${ORIGIN}/_lunora/admin/functions`, `lnat.ci.${"x".repeat(43)}`))).resolves.toBe(403);
        await expect(status(call(worker, `${ORIGIN}/_lunora/admin/functions`, `lnat.nobody.${"x".repeat(43)}`))).resolves.toBe(403);

        const before = seen.length;

        await call(worker, `${ORIGIN}/_lunora/admin/functions`, "lnat.ci.too-short");

        // A malformed bearer is refused before any store round trip.
        expect(seen).toHaveLength(before);
    });

    it("keeps a named token out of token management and the WebSocket admin plane", async () => {
        expect.assertions(4);

        const { token, worker } = await setup();

        await expect(errorCodeOf(call(worker, TOKENS, token))).resolves.toBe("ADMIN_ROOT_REQUIRED");
        await expect(errorCodeOf(call(worker, TOKENS, token, { body: JSON.stringify({ name: "ci2" }), method: "POST" }))).resolves.toBe("ADMIN_ROOT_REQUIRED");
        await expect(errorCodeOf(call(worker, `${TOKENS}?name=ci`, token, { method: "DELETE" }))).resolves.toBe("ADMIN_ROOT_REQUIRED");
        await expect(errorCodeOf(call(worker, `${ORIGIN}/_lunora/admin/ws-token`, token, { method: "POST" }))).resolves.toBe("ADMIN_ROOT_REQUIRED");
    });

    it("accepts a token created right after its name was refused", async () => {
        expect.assertions(2);

        const { worker } = await setup();

        await expect(status(call(worker, `${ORIGIN}/_lunora/admin/functions`, `lnat.fresh.${"x".repeat(43)}`))).resolves.toBe(403);

        const created = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "fresh" }), method: "POST" });
        const { token } = await created.json<{ token: string }>();

        await expect(status(call(worker, `${ORIGIN}/_lunora/admin/functions`, token))).resolves.toBe(200);
    });

    it("refuses a revoked token at once on the isolate that revoked it", async () => {
        expect.assertions(3);

        const { token, worker } = await setup();

        await expect(status(call(worker, `${ORIGIN}/_lunora/admin/functions`, token))).resolves.toBe(200);
        await expect(status(call(worker, `${TOKENS}?name=ci`, ROOT, { method: "DELETE" }))).resolves.toBe(200);
        await expect(status(call(worker, `${ORIGIN}/_lunora/admin/functions`, token))).resolves.toBe(403);
    });

    it("hands the shard a signed signal for an admin RPC, never the secret", async () => {
        expect.assertions(4);

        const { seen, token, worker } = await setup();

        await call(worker, `${ORIGIN}/_lunora/rpc`, token, { body: JSON.stringify({ args: {}, functionPath: "__lunora_admin__:listTables" }), method: "POST" });

        const forwarded = seen.at(-1) as SeenRequest;

        expect(forwarded.body).toContain("__lunora_admin__:listTables");
        expect(forwarded.headers.authorization).toBeUndefined();
        await expect(verifyAdminSignal(ROOT, forwarded.headers[ADMIN_SIGNAL_HEADER] ?? "")).resolves.toBe("ci");
        expect(JSON.stringify(seen)).not.toContain(token.split(".")[2]);
    });

    it("forwards neither secret nor signal for an unverified named token", async () => {
        expect.assertions(2);

        const { seen, worker } = await setup();
        const forged = `lnat.ci.${"y".repeat(43)}`;

        await call(worker, `${ORIGIN}/_lunora/rpc`, forged, {
            body: JSON.stringify({ args: {}, functionPath: "__lunora_admin__:listTables" }),
            method: "POST",
        });

        const forwarded = seen.at(-1) as SeenRequest;

        expect(forwarded.headers.authorization).toBeUndefined();
        expect(forwarded.headers[ADMIN_SIGNAL_HEADER]).toBeUndefined();
    });
});

describe("credentials that outlive the request", () => {
    // A signed URL, a session for another user or a chosen password would keep
    // working after the named token that minted it is revoked.
    const mintingWorker = async () => {
        const { namespace } = fakeShards();
        const storageSignedUrl = vi.fn<() => Promise<string>>(async () => "https://signed.example/object");
        const impersonateUser = vi.fn<() => Promise<Record<string, unknown>>>(async () => {
            return { session: { token: "user-session" } };
        });
        const worker = createWorker({
            adminToken: ROOT,
            authAdmin: { impersonateUser } as never,
            functions: REGISTRY,
            shardDO: namespace,
            storageSignedUrl,
        });
        const created = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        const { token } = await created.json<{ token: string }>();

        return { impersonateUser, storageSignedUrl, token, worker };
    };

    it("refuses a named token, and lets the root token through", async () => {
        expect.assertions(6);

        const { impersonateUser, storageSignedUrl, token, worker } = await mintingWorker();
        const signUrl = `${ORIGIN}/_lunora/admin/storage/url?key=a.txt`;
        const impersonate = (bearer: string): Promise<Response> =>
            call(worker, `${ORIGIN}/_lunora/admin/auth/users/impersonate`, bearer, { body: JSON.stringify({ userId: "u1" }), method: "POST" });

        await expect(errorCodeOf(call(worker, signUrl, token))).resolves.toBe("ADMIN_ROOT_REQUIRED");
        await expect(errorCodeOf(impersonate(token))).resolves.toBe("ADMIN_ROOT_REQUIRED");
        expect(storageSignedUrl).not.toHaveBeenCalled();
        expect(impersonateUser).not.toHaveBeenCalled();

        await expect(status(call(worker, signUrl, ROOT))).resolves.toBe(200);
        await expect(status(impersonate(ROOT))).resolves.toBe(200);
    });
});

describe("auth jurisdiction move", () => {
    it("is root-only: a named token can neither overwrite pinned auth rows nor purge the unpinned tables", async () => {
        expect.assertions(6);

        const { namespace } = fakeShards();
        const copy = vi.fn<() => Promise<{ done: boolean; tables: [] }>>(async () => {
            return { done: true, tables: [] };
        });
        const purge = vi.fn<() => Promise<{ dropped: string[] }>>(async () => {
            return { dropped: [] };
        });
        const worker = createWorker({ adminToken: ROOT, authJurisdictionMove: { copy, purge }, functions: REGISTRY, shardDO: namespace });
        const created = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        const { token } = await created.json<{ token: string }>();
        const move = (bearer: string, functionPath: string): Promise<Response> =>
            call(worker, `${ORIGIN}/_lunora/rpc`, bearer, { body: JSON.stringify({ args: { force: true }, functionPath }), method: "POST" });

        await expect(errorCodeOf(move(token, "__lunora_admin__:copyAuthToJurisdiction"))).resolves.toBe("ADMIN_ROOT_REQUIRED");
        await expect(errorCodeOf(move(token, "__lunora_admin__:purgeUnpinnedAuth"))).resolves.toBe("ADMIN_ROOT_REQUIRED");
        expect(copy).not.toHaveBeenCalled();
        expect(purge).not.toHaveBeenCalled();

        await expect(status(move(ROOT, "__lunora_admin__:copyAuthToJurisdiction"))).resolves.toBe(200);
        await expect(status(move(ROOT, "__lunora_admin__:purgeUnpinnedAuth"))).resolves.toBe(200);
    });
});

describe("a token store outage", () => {
    it("refuses while the store is down, says so in the log without the secret, and recovers with the store", async () => {
        expect.assertions(4);

        const outage: ShardHooks = { down: false };
        const { namespace } = fakeShards(outage);
        const worker = createWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });
        const created = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        const { token } = await created.json<{ token: string }>();
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

        outage.down = true;

        await expect(status(call(worker, `${ORIGIN}/_lunora/admin/functions`, token))).resolves.toBe(403);

        const logged = errors.mock.calls.flat().map(String).join("\n");

        errors.mockRestore();

        expect(logged).toContain('admin token store lookup for "ci" failed');
        expect(logged).not.toContain(token.split(".")[2]);

        // No clock moves: a refusal the store never decided is not remembered.
        outage.down = false;

        await expect(status(call(worker, `${ORIGIN}/_lunora/admin/functions`, token))).resolves.toBe(200);
    });
});

describe("named admin token import", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("signs the shard hop after the upload, so a slow body does not outlast the signal", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(0);

        const { seen, token, worker } = await setup();
        const line = (id: string): Uint8Array => new TextEncoder().encode(`${JSON.stringify({ doc: { _id: id, body: "hi" }, table: "messages" })}\n`);
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    pulls += 1;

                    if (pulls === 1) {
                        controller.enqueue(line("m1"));

                        return;
                    }

                    // The importer has read the first line: the rest of the upload takes longer than a signal lives.
                    vi.setSystemTime(61_000);
                    controller.enqueue(line("m2"));
                    controller.close();
                },
            },
            { highWaterMark: 0 },
        );

        await worker.fetch(
            new Request(`${ORIGIN}/_lunora/admin/import`, {
                body,
                duplex: "half",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/x-ndjson" },
                method: "POST",
            } as RequestInit),
            {},
            fakeContext,
        );

        const imported = seen.find((request) => request.body.includes("__lunora_admin__:importShard"));
        const signal = imported?.headers[ADMIN_SIGNAL_HEADER] ?? "";

        expect(imported).toBeDefined();
        await expect(verifyAdminSignal(ROOT, signal)).resolves.toBe("ci");
    });
});

describe("named admin token fan-out", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const SHARDS = ["s1", "s2", "s3"];

    /** A migration fanned out one shard at a time, with `onShard` run as each shard is reached. */
    const migrate = async (onShard: (index: number, worker: ReturnType<typeof createWorker>) => Promise<void>) => {
        const received: { now: number; signal: string | undefined }[] = [];
        const hooks: ShardHooks = {};
        const { namespace, seen } = fakeShards(hooks);
        const worker = createWorker({
            adminToken: ROOT,
            functions: REGISTRY,
            queryCoordinator: createQueryCoordinator({ maxConcurrency: 1, registry: createStaticShardRegistry({ messages: SHARDS }) }),
            shardDO: namespace,
        });
        const created = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        const { token } = await created.json<{ token: string }>();

        hooks.onAdminOp = async (functionPath) => {
            if (functionPath !== "__lunora_admin__:runMigration") {
                return;
            }

            received.push({ now: Date.now(), signal: seen.at(-1)?.headers[ADMIN_SIGNAL_HEADER] });
            await onShard(received.length, worker);
        };

        await call(worker, `${ORIGIN}/_lunora/migrate`, token, {
            body: JSON.stringify({ args: { id: "m1" }, functionPath: "__lunora_admin__:runMigration", table: "messages" }),
            method: "POST",
        });

        return Promise.all(received.map(async ({ now, signal }) => (signal === undefined ? undefined : verifyAdminSignal(ROOT, signal, now))));
    };

    it("signs every shard call afresh, so a fan-out can outlast one signal", async () => {
        expect.assertions(1);

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(0);

        const names = await migrate(async (index) => {
            if (index === 1) {
                vi.setSystemTime(61_000);
            }
        });

        expect(names).toStrictEqual(["ci", "ci", "ci"]);
    });

    it("signs an authorized admin fan-out sent over the RPC route", async () => {
        expect.assertions(1);

        const { namespace, seen } = fakeShards();
        const worker = createWorker({
            adminToken: ROOT,
            authorizeFanOut: () => true,
            functions: REGISTRY,
            queryCoordinator: createQueryCoordinator({ registry: createStaticShardRegistry({ messages: SHARDS }) }),
            shardDO: namespace,
        });
        const created = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        const { token } = await created.json<{ token: string }>();

        await call(worker, `${ORIGIN}/_lunora/rpc`, token, {
            body: JSON.stringify({ args: {}, fanOut: { merge: { kind: "concat" }, table: "messages" }, functionPath: "__lunora_admin__:listTables" }),
            method: "POST",
        });

        const signals = seen
            .filter((request) => request.body.includes("__lunora_admin__:listTables"))
            .map((request) => request.headers[ADMIN_SIGNAL_HEADER] ?? "");

        await expect(Promise.all(signals.map(async (signal) => verifyAdminSignal(ROOT, signal)))).resolves.toStrictEqual(["ci", "ci", "ci"]);
    });

    it("stops signing shard calls once the token is revoked mid-fan-out", async () => {
        expect.assertions(1);

        const names = await migrate(async (index, worker) => {
            if (index === 1) {
                await call(worker, `${TOKENS}?name=ci`, ROOT, { method: "DELETE" });
            }
        });

        expect(names).toStrictEqual(["ci", undefined, undefined]);
    });
});

describe("auth admin ops a named token may call", () => {
    it("allows only listed ops — a role grant needs the root token", async () => {
        expect.assertions(3);

        const { namespace } = fakeShards();
        const setRole = vi.fn<() => Promise<Record<string, unknown>>>(async () => {
            return { id: "u1" };
        });
        const listUsers = vi.fn<() => Promise<Record<string, unknown>>>(async () => {
            return { total: 0, users: [] };
        });
        const worker = createWorker({ adminToken: ROOT, authAdmin: { listUsers, setRole } as never, functions: REGISTRY, shardDO: namespace });
        const created = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        const { token } = await created.json<{ token: string }>();

        await expect(status(call(worker, `${ORIGIN}/_lunora/admin/auth/users`, token))).resolves.toBe(200);
        await expect(
            errorCodeOf(
                call(worker, `${ORIGIN}/_lunora/admin/auth/users/role`, token, { body: JSON.stringify({ role: "admin", userId: "u1" }), method: "POST" }),
            ),
        ).resolves.toBe("ADMIN_ROOT_REQUIRED");
        expect(setRole).not.toHaveBeenCalled();
    });
});

describe("named admin tokens on the scheduler socket", () => {
    it("refuses a named bearer on the admin socket upgrade and admits the root token", async () => {
        expect.assertions(2);

        const { namespace } = fakeShards();
        const schedulerDO: ShardNamespaceLike = {
            get: () => {
                return { fetch: async () => new Response("socket") };
            },
            idFromName: (name) => {
                return { __name: name };
            },
        };
        const worker = createWorker({ adminToken: ROOT, functions: REGISTRY, schedulerDO, shardDO: namespace });
        const created = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        const { token } = await created.json<{ token: string }>();
        const upgrade = (bearer: string): Promise<Response> =>
            worker.fetch(
                new Request(`${ORIGIN}/_lunora/admin/scheduled/ws`, { headers: { authorization: `Bearer ${bearer}`, upgrade: "websocket" } }),
                {},
                fakeContext,
            );

        // A socket outlives the request that opened it, so a named token would keep it past revocation.
        await expect(status(upgrade(token))).resolves.toBe(403);
        await expect(status(upgrade(ROOT))).resolves.toBe(200);
    });
});

describe("named admin token secrets in logs", () => {
    it("never writes the secret to the console across create, use, forward and revoke", async () => {
        expect.assertions(1);

        const logged: string[] = [];
        const spies = (["debug", "error", "info", "log", "warn"] as const).map((level) =>
            vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => {
                logged.push(
                    parts.map((part) => (part instanceof Error ? `${part.message} ${String(part.stack)}` : (JSON.stringify(part) ?? String(part)))).join(" "),
                );
            }),
        );

        const { token, worker } = await setup();

        await call(worker, `${ORIGIN}/_lunora/admin/functions`, token);
        await call(worker, `${ORIGIN}/_lunora/rpc`, token, { body: JSON.stringify({ args: {}, functionPath: "__lunora_admin__:listTables" }), method: "POST" });
        await call(worker, `${ORIGIN}/_lunora/rpc`, token, { body: JSON.stringify({ args: {}, functionPath: "messages:list" }), method: "POST" });
        await call(worker, TOKENS, token, { body: JSON.stringify({ name: "ci2" }), method: "POST" });
        await call(worker, `${TOKENS}?name=ci`, ROOT, { method: "DELETE" });
        await call(worker, `${ORIGIN}/_lunora/admin/functions`, token);

        for (const spy of spies) {
            spy.mockRestore();
        }

        expect(logged.join("\n")).not.toContain(token.split(".")[2]);
    });
});

describe("a malformed named-token bearer", () => {
    it("never reaches the token store", async () => {
        expect.assertions(1);

        const { namespace, seen } = fakeShards();
        const worker = createWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });
        const rpc = { body: JSON.stringify({ args: {}, functionPath: "__lunora_admin__:listTables" }), method: "POST" };

        await call(worker, `${ORIGIN}/_lunora/rpc`, `lnat.ci.${"z".repeat(42)}`, rpc);
        await call(worker, `${ORIGIN}/_lunora/admin/tokens`, `lnat.CI.${"z".repeat(43)}`);

        // Whatever the worker forwards, none of it asks the token store.
        expect(seen.filter((request) => request.body.includes("AdminToken"))).toHaveLength(0);
    });
});

describe("a named token's AI chat tool calls", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    /** A model that asks for one read tool, then answers. */
    const toolThenAnswer = (): { run: () => Promise<{ response: string }> } => {
        let turn = 0;

        return {
            run: async () => {
                turn += 1;

                return { response: turn === 1 ? '```tool\n{"name":"describeTables"}\n```' : "Done." };
            },
        };
    };

    const chat = (bearer: string): Request =>
        new Request(`${ORIGIN}/_lunora/rpc`, {
            body: JSON.stringify({ args: { prompt: "what tables?" }, functionPath: "__lunora_admin__:aiChat" }),
            headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
            method: "POST",
        });

    const toolCalls = (seen: SeenRequest[]): SeenRequest[] => seen.filter((request) => request.body.includes("describeTables"));

    it("reach the shard as the named token, never as root", async () => {
        expect.assertions(3);

        const { namespace, seen } = fakeShards();
        const worker = createWorker({ adminToken: ROOT, aiChatBinding: toolThenAnswer(), functions: REGISTRY, shardDO: namespace });
        const created = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        const { token } = await created.json<{ token: string }>();

        const response = await worker.fetch(chat(token), {}, fakeContext);

        await response.text();

        const forwarded = toolCalls(seen);

        expect(forwarded.length).toBeGreaterThan(0);
        expect(forwarded.every((request) => request.headers["authorization"] === undefined)).toBe(true);
        expect(forwarded.every((request) => request.headers[ADMIN_SIGNAL_HEADER] !== undefined)).toBe(true);
    });

    it("carry a fresh signal on every call, so a long turn outlives the first one", async () => {
        expect.assertions(4);

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(0);

        const { namespace, seen } = fakeShards();
        let turn = 0;
        const slowModel = {
            run: async (): Promise<{ response: string }> => {
                turn += 1;
                // Generation takes a minute between tool rounds: past any signal minted at the start.
                vi.setSystemTime(turn * 60_000);

                return { response: turn <= 2 ? '```tool\n{"name":"describeTables"}\n```' : "Done." };
            },
        };
        const worker = createWorker({ adminToken: ROOT, aiChatBinding: slowModel, functions: REGISTRY, shardDO: namespace });
        const created = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        const { token } = await created.json<{ token: string }>();

        const response = await worker.fetch(chat(token), {}, fakeContext);

        await response.text();

        const forwarded = toolCalls(seen);

        expect(forwarded).toHaveLength(2);
        expect(forwarded.every((request) => request.headers["authorization"] === undefined)).toBe(true);

        // Each call's signal is valid when the call is made: the second is minted a minute after the first.
        const [first, second] = forwarded.map((request) => request.headers[ADMIN_SIGNAL_HEADER] ?? "");

        await expect(verifyAdminSignal(ROOT, first ?? "", 60_000 + 1)).resolves.toBe("ci");
        await expect(verifyAdminSignal(ROOT, second ?? "", 120_000 + 1)).resolves.toBe("ci");
    });

    it("still reach the shard as root for the root token", async () => {
        expect.assertions(2);

        const { namespace, seen } = fakeShards();
        const worker = createWorker({ adminToken: ROOT, aiChatBinding: toolThenAnswer(), functions: REGISTRY, shardDO: namespace });

        const response = await worker.fetch(chat(ROOT), {}, fakeContext);

        await response.text();

        const forwarded = toolCalls(seen);

        expect(forwarded.length).toBeGreaterThan(0);
        expect(forwarded.every((request) => request.headers["authorization"] === `Bearer ${ROOT}`)).toBe(true);
    });
});

describe("named admin token shard signals", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("never outlive the token's own expiry", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(0);

        const { namespace, seen } = fakeShards();
        const worker = createWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });
        const created = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ expiresAt: 10_000, name: "ci" }), method: "POST" });
        const { token } = await created.json<{ token: string }>();

        await call(worker, `${ORIGIN}/_lunora/rpc`, token, { body: JSON.stringify({ args: {}, functionPath: "__lunora_admin__:listTables" }), method: "POST" });

        const signal = seen.at(-1)?.headers[ADMIN_SIGNAL_HEADER] ?? "";

        await expect(verifyAdminSignal(ROOT, signal, 9999)).resolves.toBe("ci");
        await expect(verifyAdminSignal(ROOT, signal, 10_000)).resolves.toBeUndefined();
    });

    it("outlive the worker-to-shard hop even when the grant is about to leave the cache", async () => {
        expect.assertions(1);

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(0);

        const { namespace, seen } = fakeShards();
        const worker = createWorker({ adminToken: ROOT, functions: REGISTRY, shardDO: namespace });
        const created = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        const { token } = await created.json<{ token: string }>();
        const rpc = { body: JSON.stringify({ args: {}, functionPath: "__lunora_admin__:listTables" }), method: "POST" };

        await call(worker, `${ORIGIN}/_lunora/rpc`, token, rpc);

        // One millisecond before the cached grant lapses.
        vi.setSystemTime(ADMIN_TOKEN_CACHE_TTL_MS - 1);
        await call(worker, `${ORIGIN}/_lunora/rpc`, token, rpc);

        const signal = seen.at(-1)?.headers[ADMIN_SIGNAL_HEADER] ?? "";

        await expect(verifyAdminSignal(ROOT, signal, ADMIN_TOKEN_CACHE_TTL_MS + 1000)).resolves.toBe("ci");
    });

    it("are not minted for a token revoked after its grant was recorded", async () => {
        expect.assertions(2);

        const { namespace, seen } = fakeShards();
        const hook: { revoke?: () => Promise<void> } = {};
        const worker = createWorker({
            adminToken: ROOT,
            functions: REGISTRY,
            // Identity resolution runs between the grant and the signal; the revoke lands there.
            resolveIdentity: async () => {
                const { revoke } = hook;

                hook.revoke = undefined;
                await revoke?.();

                return null;
            },
            shardDO: namespace,
        });
        const created = await call(worker, TOKENS, ROOT, { body: JSON.stringify({ name: "ci" }), method: "POST" });
        const { token } = await created.json<{ token: string }>();

        hook.revoke = async () => {
            await call(worker, `${TOKENS}?name=ci`, ROOT, { method: "DELETE" });
        };

        await call(worker, `${ORIGIN}/_lunora/rpc`, token, { body: JSON.stringify({ args: {}, functionPath: "__lunora_admin__:listTables" }), method: "POST" });

        const forwarded = seen.findLast((request) => request.body.includes("__lunora_admin__:listTables"));

        expect(forwarded).toBeDefined();
        expect(forwarded?.headers[ADMIN_SIGNAL_HEADER]).toBeUndefined();
    });
});

describe("a root token shaped like a named token", () => {
    it("is forwarded as the root bearer on an admin RPC and a WebSocket upgrade", async () => {
        expect.assertions(2);

        const root = `lnat.root.${"r".repeat(43)}`;
        const { namespace, seen } = fakeShards();
        const worker = createWorker({ adminToken: root, functions: REGISTRY, shardDO: namespace });

        await call(worker, `${ORIGIN}/_lunora/rpc`, root, { body: JSON.stringify({ args: {}, functionPath: "__lunora_admin__:listTables" }), method: "POST" });

        expect(seen.at(-1)?.headers["authorization"]).toBe(`Bearer ${root}`);

        await worker.fetch(
            new Request(`${ORIGIN}/_lunora/ws`, { headers: { authorization: `Bearer ${root}`, connection: "Upgrade", upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(seen.at(-1)?.headers["authorization"]).toBe(`Bearer ${root}`);
    });
});

describe("named admin tokens on a WebSocket upgrade", () => {
    it("strips the secret from the forwarded upgrade", async () => {
        expect.assertions(2);

        const { seen, token, worker } = await setup();

        await worker.fetch(
            new Request(`${ORIGIN}/_lunora/ws`, { headers: { authorization: `Bearer ${token}`, connection: "Upgrade", upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        const forwarded = seen.at(-1) as SeenRequest;

        expect(forwarded.body).toBe("");
        expect(JSON.stringify(forwarded.headers)).not.toContain(token);
    });
});

const nameOf = async (pending: Promise<undefined | { name: string }>): Promise<string | undefined> => {
    const grant = await pending;

    return grant?.name;
};

describe(createAdminTokenVerifier, () => {
    const bearer = `Bearer lnat.ci.${"z".repeat(43)}`;
    const LIVE: AdminTokenLookup = { live: true };
    const WRONG_SECRET: AdminTokenLookup = { live: false, nameKnown: true };

    it("serves a verified token from cache until the TTL, then asks the store again", async () => {
        expect.assertions(4);

        let clock = 0;
        let answer: AdminTokenLookup = LIVE;
        const lookup = vi.fn<() => Promise<AdminTokenLookup>>(async () => answer);
        const verifier = createAdminTokenVerifier({ lookup, now: () => clock });

        await expect(nameOf(verifier.verify(bearer))).resolves.toBe("ci");

        // Revoked elsewhere: this isolate keeps the cached answer, within the bound.
        answer = WRONG_SECRET;
        clock = ADMIN_TOKEN_CACHE_TTL_MS - 1;

        await expect(nameOf(verifier.verify(bearer))).resolves.toBe("ci");

        clock = ADMIN_TOKEN_CACHE_TTL_MS;

        await expect(verifier.verify(bearer)).resolves.toBeUndefined();
        expect(lookup).toHaveBeenCalledTimes(2);
    });

    it("never trusts a cached grant past the token's own expiry", async () => {
        expect.assertions(2);

        let clock = 0;
        let answer: AdminTokenLookup = { expiresAt: 1000, live: true };
        const verifier = createAdminTokenVerifier({ lookup: async () => answer, now: () => clock });

        await expect(nameOf(verifier.verify(bearer))).resolves.toBe("ci");

        answer = WRONG_SECRET;
        clock = 1000;

        await expect(verifier.verify(bearer)).resolves.toBeUndefined();
    });

    it("refuses a grant whose token expired while the store's answer was in flight", async () => {
        expect.assertions(2);

        let clock = 0;
        const lookup = vi.fn<() => Promise<AdminTokenLookup>>(async () => {
            // The store answered "live" just before expiry; the answer lands after it.
            clock = 1000;

            return { expiresAt: 1000, live: true };
        });
        const verifier = createAdminTokenVerifier({ lookup, now: () => clock });

        await expect(verifier.verify(bearer)).resolves.toBeUndefined();

        clock = 0;
        lookup.mockImplementation(async () => {
            return { expiresAt: 1000, live: true };
        });

        await expect(nameOf(verifier.verify(bearer))).resolves.toBe("ci");
    });

    it("does not remember a refusal the store did not decide", async () => {
        expect.assertions(3);

        const lookup = vi.fn<() => Promise<AdminTokenLookup>>(async () => {
            return { live: false, nameKnown: true, transient: true };
        });
        const verifier = createAdminTokenVerifier({ lookup, now: () => 0 });

        await expect(verifier.verify(bearer)).resolves.toBeUndefined();

        lookup.mockImplementation(async () => LIVE);

        await expect(nameOf(verifier.verify(bearer))).resolves.toBe("ci");
        expect(lookup).toHaveBeenCalledTimes(2);
    });

    it("does not cache a grant whose lookup raced a revoke", async () => {
        expect.assertions(3);

        // Each lookup parks; `asked` hands the test the release handle once the store is asked.
        const parked: ((release: (answer: AdminTokenLookup) => void) => void)[] = [];
        const asked = (): Promise<(answer: AdminTokenLookup) => void> =>
            new Promise((resolve) => {
                parked.push(resolve);
            });
        const lookup = vi.fn<() => Promise<AdminTokenLookup>>(
            () =>
                new Promise((resolve) => {
                    parked.shift()?.(resolve);
                }),
        );
        const verifier = createAdminTokenVerifier({ lookup, now: () => 0 });

        const firstAsked = asked();
        const inFlight = verifier.verify(bearer);
        const releaseFirst = await firstAsked;

        // The revoke lands while the store's (now stale) "live" answer is on its way back.
        verifier.evict("ci");
        releaseFirst(LIVE);

        await expect(inFlight).resolves.toBeUndefined();

        const secondAsked = asked();
        const next = verifier.verify(bearer);

        (await secondAsked)(WRONG_SECRET);

        await expect(next).resolves.toBeUndefined();
        expect(lookup).toHaveBeenCalledTimes(2);
    });

    it("remembers an unknown name briefly for every secret, and a wrong secret only for itself", async () => {
        expect.assertions(4);

        let clock = 0;
        const lookup = vi.fn<(name: string) => Promise<AdminTokenLookup>>(async (name) => {
            return { live: false, nameKnown: name === "ci" };
        });
        const verifier = createAdminTokenVerifier({ lookup, now: () => clock });

        await verifier.verify(`Bearer lnat.ghost.${"a".repeat(43)}`);
        await verifier.verify(`Bearer lnat.ghost.${"b".repeat(43)}`);

        // One round trip for the unknown name, whatever secret is guessed next.
        expect(lookup).toHaveBeenCalledTimes(1);

        await verifier.verify(`Bearer lnat.ci.${"a".repeat(43)}`);
        await verifier.verify(`Bearer lnat.ci.${"b".repeat(43)}`);

        // A known name is never locked out by guesses: each new secret is asked about.
        expect(lookup).toHaveBeenCalledTimes(3);

        clock = ADMIN_TOKEN_REFUSAL_TTL_MS;
        await verifier.verify(`Bearer lnat.ghost.${"a".repeat(43)}`);

        expect(lookup).toHaveBeenCalledTimes(4);

        verifier.evict("ghost");
        await verifier.verify(`Bearer lnat.ghost.${"a".repeat(43)}`);

        expect(lookup).toHaveBeenCalledTimes(5);
    });

    describe("concurrent checks of one token", () => {
        const header = `Bearer lnat.ci.${"z".repeat(43)}`;

        /** Lets every pending digest and lookup call run to its next await. */
        const settle = async (): Promise<void> =>
            new Promise((resolve) => {
                setImmediate(resolve);
            });

        /** A store whose answers the test releases by hand, and that says when its Nth lookup has reached it. */
        const heldStore = (): {
            lookup: ReturnType<typeof vi.fn<() => Promise<AdminTokenLookup>>>;
            release: (answer: AdminTokenLookup) => void;
            started: (count: number) => Promise<void>;
        } => {
            const releasers: ((answer: AdminTokenLookup) => void)[] = [];
            const waiters: { count: number; resolve: () => void }[] = [];
            let calls = 0;
            const lookup = vi.fn<() => Promise<AdminTokenLookup>>(async () => {
                calls += 1;

                for (const waiter of waiters) {
                    if (waiter.count <= calls) {
                        waiter.resolve();
                    }
                }

                return new Promise<AdminTokenLookup>((resolve) => {
                    releasers.push(resolve);
                });
            });

            return {
                lookup,
                release: (answer) => {
                    // The oldest lookup still waiting, so a test answers them in the order they were asked.
                    releasers.shift()?.(answer);
                },
                started: async (count) =>
                    new Promise<void>((resolve) => {
                        if (calls >= count) {
                            resolve();

                            return;
                        }

                        waiters.push({ count, resolve });
                    }),
            };
        };

        it("share one store lookup", async () => {
            expect.assertions(2);

            const store = heldStore();
            const verifier = createAdminTokenVerifier({ lookup: store.lookup, now: () => 0 });
            const waiting = Array.from({ length: 16 }, async () => verifier.verify(header));

            await store.started(1);
            await settle();
            store.release({ live: true });

            const grants = await Promise.all(waiting);

            expect(store.lookup).toHaveBeenCalledTimes(1);
            expect(grants.every((grant) => grant?.name === "ci")).toBe(true);
        });

        it("void a caller waiting on a lookup that raced a revoke, and never hand its answer to a later caller", async () => {
            expect.assertions(3);

            const store = heldStore();
            const verifier = createAdminTokenVerifier({ lookup: store.lookup, now: () => 0 });
            const first = verifier.verify(header);

            await store.started(1);
            // The revoke lands while the answer is in flight; a caller arriving after it must ask again.
            verifier.evict("ci");

            const third = verifier.verify(header);

            await store.started(2);
            store.release({ live: true });

            await expect(first).resolves.toBeUndefined();

            store.release({ live: false, nameKnown: true });

            await expect(third).resolves.toBeUndefined();
            expect(store.lookup).toHaveBeenCalledTimes(2);
        });
    });

    describe("against anonymous floods", () => {
        const secret = "z".repeat(43);
        const withName = (name: string): string => `Bearer lnat.${name}.${secret}`;

        it.each([
            ["a short secret", `Bearer lnat.ci.${"z".repeat(42)}`],
            ["a long secret", `Bearer lnat.ci.${"z".repeat(44)}`],
            ["a secret outside base64url", `Bearer lnat.ci.${"z".repeat(42)}+`],
            ["an upper-case name", `Bearer lnat.CI.${secret}`],
            ["a dotted name", `Bearer lnat.a.b.${secret}`],
            ["a name over 64 characters", `Bearer lnat.${"a".repeat(65)}.${secret}`],
            ["another prefix", `Bearer lnap.ci.${secret}`],
            ["no secret", "Bearer lnat.ci."],
        ])("never looks up %s", async (_label, header) => {
            expect.assertions(2);

            const lookup = vi.fn<() => Promise<AdminTokenLookup>>(async () => {
                return { live: true };
            });
            const verifier = createAdminTokenVerifier({ lookup });

            await expect(verifier.verify(header)).resolves.toBeUndefined();
            expect(lookup).not.toHaveBeenCalled();
        });

        it("makes at most the burst of lookups for a stream of fresh unknown names", async () => {
            expect.assertions(2);

            const lookup = vi.fn<() => Promise<AdminTokenLookup>>(async () => {
                return { live: false, nameKnown: false };
            });
            const verifier = createAdminTokenVerifier({ lookup, now: () => 0 });

            await Promise.all(
                Array.from({ length: ADMIN_TOKEN_UNKNOWN_NAME_BURST + 1 }, async (_unused, index) => verifier.verify(withName(`fresh${String(index)}`))),
            );

            expect(lookup).toHaveBeenCalledTimes(ADMIN_TOKEN_UNKNOWN_NAME_BURST);

            // The budget refills with time, so the stream is throttled rather than locked out.
            const clock = 60_000;
            const later = createAdminTokenVerifier({ lookup, now: () => clock });

            await later.verify(withName("again"));

            expect(lookup).toHaveBeenCalledTimes(ADMIN_TOKEN_UNKNOWN_NAME_BURST + 1);
        });

        it("still verifies a real token on an isolate whose unknown-name budget a flood has drained", async () => {
            expect.assertions(3);

            const lookup = vi.fn<(name: string) => Promise<AdminTokenLookup>>(async (name) =>
                name === "ci" ? { live: true } : { live: false, nameKnown: false },
            );
            const listNames = vi.fn<() => Promise<string[]>>(async () => ["ci"]);
            const verifier = createAdminTokenVerifier({ listNames, lookup, now: () => 0 });

            await Promise.all(
                Array.from({ length: ADMIN_TOKEN_UNKNOWN_NAME_BURST * 2 }, async (_unused, index) => verifier.verify(withName(`fake${String(index)}`))),
            );

            // The real token's name has never been seen here, and the budget is gone.
            await expect(nameOf(verifier.verify(withName("ci")))).resolves.toBe("ci");

            // Floods keep refusing invented names, and cost the store one name listing, not one lookup each.
            await Promise.all(Array.from({ length: 50 }, async (_unused, index) => verifier.verify(withName(`more${String(index)}`))));

            expect(listNames).toHaveBeenCalledTimes(1);
            expect(lookup.mock.calls.filter(([name]) => name.startsWith("more"))).toHaveLength(0);
        });

        it("refreshes the listed names again once its interval has passed, and a name not listed stays refused", async () => {
            expect.assertions(3);

            let clock = 0;
            let names = ["ci"];
            const lookup = vi.fn<(name: string) => Promise<AdminTokenLookup>>(async (name) =>
                names.includes(name) ? { live: true } : { live: false, nameKnown: false },
            );
            const listNames = vi.fn<() => Promise<string[]>>(async () => names);
            const verifier = createAdminTokenVerifier({ listNames, lookup, now: () => clock });

            await Promise.all(
                Array.from({ length: ADMIN_TOKEN_UNKNOWN_NAME_BURST + 1 }, async (_unused, index) => verifier.verify(withName(`fake${String(index)}`))),
            );

            // Created after the last listing: refused until the next refresh window, then accepted.
            names = ["ci", "later"];

            await expect(nameOf(verifier.verify(withName("later")))).resolves.toBeUndefined();

            clock = 6000;
            // Drain what the clock refilled, so only the name listing can admit the name.
            await Promise.all(Array.from({ length: 10 }, async (_unused, index) => verifier.verify(withName(`again${String(index)}`))));

            await expect(nameOf(verifier.verify(withName("later")))).resolves.toBe("later");
            expect(listNames).toHaveBeenCalledTimes(2);
        });

        it("keeps serving a cached token, and a known name, while the unknown-name budget is spent", async () => {
            expect.assertions(4);

            let clock = 0;
            const lookup = vi.fn<(name: string) => Promise<AdminTokenLookup>>(async (name) =>
                name === "ci" ? { live: true } : { live: false, nameKnown: false },
            );
            const verifier = createAdminTokenVerifier({ lookup, now: () => clock });

            await expect(nameOf(verifier.verify(withName("ci")))).resolves.toBe("ci");

            await Promise.all(
                Array.from({ length: ADMIN_TOKEN_UNKNOWN_NAME_BURST * 2 + 1 }, async (_unused, index) => verifier.verify(withName(`fresh${String(index)}`))),
            );

            const before = lookup.mock.calls.length;

            await expect(nameOf(verifier.verify(withName("ci")))).resolves.toBe("ci");

            // Past the cache window the known name is asked again — without spending the spent budget.
            clock = ADMIN_TOKEN_CACHE_TTL_MS + 1;

            await expect(nameOf(verifier.verify(withName("ci")))).resolves.toBe("ci");
            expect(lookup).toHaveBeenCalledTimes(before + 1);
        });

        it("makes a revoked name spend budget again", async () => {
            expect.assertions(2);

            const lookup = vi.fn<() => Promise<AdminTokenLookup>>(async () => {
                return { live: true };
            });
            const verifier = createAdminTokenVerifier({ lookup, now: () => 0 });

            await verifier.verify(withName("ci"));
            verifier.evict("ci");

            await Promise.all(
                Array.from({ length: ADMIN_TOKEN_UNKNOWN_NAME_BURST }, async (_unused, index) => verifier.verify(withName(`fresh${String(index)}`))),
            );

            lookup.mockClear();

            await expect(verifier.verify(withName("ci"))).resolves.toBeUndefined();
            expect(lookup).not.toHaveBeenCalled();
        });
    });
});
