import { describe, expect, it } from "vitest";

import { mintWsAdminToken, verifyWsAdminToken } from "../../../shared/ws-admin-token";
import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const noopNamespace: ShardNamespaceLike = {
    get: () => {
        return { fetch: async () => new Response("not used", { status: 200 }) };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

const ADMIN_TOKEN = "admin-bear";
const MINT_URL = "https://app.example/_lunora/admin/ws-token";

/** A scheduler namespace whose stub records the pathnames it receives. */
const recordingScheduler = (): { calls: string[]; namespace: ShardNamespaceLike } => {
    const calls: string[] = [];

    const stub = {
        fetch: async (request: Request): Promise<Response> => {
            calls.push(new URL(request.url).pathname);

            return Response.json({ ok: true });
        },
    };

    return {
        calls,
        namespace: {
            get: () => stub,
            idFromName: (name) => {
                return { __name: name };
            },
        },
    };
};

describe("shared/ws-admin-token — mint + verify", () => {
    it("round-trips: a freshly minted token verifies against the same secret", async () => {
        expect.assertions(3);

        const minted = await mintWsAdminToken(ADMIN_TOKEN);

        expect(minted.token.startsWith("v1.")).toBe(true);
        expect(minted.expiresAtMs).toBeGreaterThan(Date.now());

        await expect(verifyWsAdminToken(ADMIN_TOKEN, minted.token)).resolves.toBe(true);
    });

    it("rejects an expired token", async () => {
        expect.assertions(1);

        const minted = await mintWsAdminToken(ADMIN_TOKEN, { now: Date.now() - 120_000, ttlMs: 60_000 });

        await expect(verifyWsAdminToken(ADMIN_TOKEN, minted.token)).resolves.toBe(false);
    });

    it("rejects a token whose signature was tampered with", async () => {
        expect.assertions(1);

        const minted = await mintWsAdminToken(ADMIN_TOKEN);
        const [version, exp, signature] = minted.token.split(".") as [string, string, string];
        const flipped = signature.startsWith("A") ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;

        await expect(verifyWsAdminToken(ADMIN_TOKEN, `${version}.${exp}.${flipped}`)).resolves.toBe(false);
    });

    it("rejects a token whose expiry was extended without re-signing", async () => {
        expect.assertions(1);

        const minted = await mintWsAdminToken(ADMIN_TOKEN);
        const [version, exp, signature] = minted.token.split(".") as [string, string, string];
        const extended = String(Number(exp) + 3_600_000);

        await expect(verifyWsAdminToken(ADMIN_TOKEN, `${version}.${extended}.${signature}`)).resolves.toBe(false);
    });

    it("rejects a token minted with a different secret", async () => {
        expect.assertions(1);

        const minted = await mintWsAdminToken("some-other-secret");

        await expect(verifyWsAdminToken(ADMIN_TOKEN, minted.token)).resolves.toBe(false);
    });

    it.each([
        ["empty", ""],
        ["master token itself", ADMIN_TOKEN],
        ["missing signature", "v1.9999999999999"],
        ["unknown version", `v2.${String(Date.now() + 60_000)}.c2ln`],
        ["non-numeric expiry", "v1.soon.c2ln"],
        ["invalid base64url signature", `v1.${String(Date.now() + 60_000)}.@@@@`],
        ["too many segments", `v1.${String(Date.now() + 60_000)}.c2ln.extra`],
    ])("rejects a malformed token (%s) without throwing", async (_label, token) => {
        expect.assertions(1);

        await expect(verifyWsAdminToken(ADMIN_TOKEN, token)).resolves.toBe(false);
    });
});

describe("createWorker — POST /_lunora/admin/ws-token", () => {
    it("rejects a mint request without the master admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });
        const response = await worker.fetch(new Request(MINT_URL, { method: "POST" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("rejects a mint request presenting an ephemeral token as the bearer (403 — sub-tokens cannot mint)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });
        const minted = await mintWsAdminToken(ADMIN_TOKEN);
        const response = await worker.fetch(new Request(MINT_URL, { headers: { authorization: `Bearer ${minted.token}` }, method: "POST" }), {}, fakeContext);

        expect(response.status).toBe(403);
    });

    it("rejects a non-POST (405)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });
        const response = await worker.fetch(new Request(MINT_URL, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "GET" }), {}, fakeContext);

        expect(response.status).toBe(405);
    });

    it("mints a verifiable short-lived token with cache-control: no-store", async () => {
        expect.assertions(4);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });
        const response = await worker.fetch(new Request(MINT_URL, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");

        const body: { expiresAtMs: number; token: string } = await response.json();

        expect(body.expiresAtMs).toBeGreaterThan(Date.now());

        await expect(verifyWsAdminToken(ADMIN_TOKEN, body.token)).resolves.toBe(true);
    });

    it("reads the signing secret from env.LUNORA_ADMIN_TOKEN when no adminToken option is set", async () => {
        expect.assertions(2);

        const worker = createWorker({ shardDO: noopNamespace });
        const response = await worker.fetch(
            new Request(MINT_URL, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, method: "POST" }),
            { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN },
            fakeContext,
        );

        expect(response.status).toBe(200);

        const body: { token: string } = await response.json();

        await expect(verifyWsAdminToken(ADMIN_TOKEN, body.token)).resolves.toBe(true);
    });

    it("answers 400 when an adminGate grants access but no static token exists to sign with", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminGate: async () => true, shardDO: noopNamespace });
        const response = await worker.fetch(new Request(MINT_URL, { method: "POST" }), {}, fakeContext);
        const body: { error?: { code?: string } } = await response.json();

        expect(response.status).toBe(400);
        expect(body.error?.code).toBe("ADMIN_TOKEN_NOT_CONFIGURED");
    });
});

describe("createWorker — scheduled admin WS gate accepts the ephemeral token", () => {
    it("accepts a minted token via ?token= on the scheduled WS upgrade", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });
        const minted = await mintWsAdminToken(ADMIN_TOKEN);

        const response = await worker.fetch(
            new Request(`https://app.example/_lunora/admin/scheduled/ws?token=${encodeURIComponent(minted.token)}`, { headers: { Upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        expect(calls).toEqual(["/ws"]);
    });

    it("refuses the raw master token via ?token= BY DEFAULT (it would leak into logs/history)", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request(`https://app.example/_lunora/admin/scheduled/ws?token=${ADMIN_TOKEN}`, { headers: { Upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(403);
        expect(calls).toEqual([]);
    });

    it("accepts the raw master token via ?token= only when explicitly opted out", async () => {
        expect.assertions(1);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, requireEphemeralWsToken: false, schedulerDO: namespace, shardDO: noopNamespace });

        await worker.fetch(
            new Request(`https://app.example/_lunora/admin/scheduled/ws?token=${ADMIN_TOKEN}`, { headers: { Upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(calls).toEqual(["/ws"]);
    });

    it("rejects an expired minted token on the scheduled WS upgrade (403)", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });
        const minted = await mintWsAdminToken(ADMIN_TOKEN, { now: Date.now() - 120_000, ttlMs: 60_000 });

        const response = await worker.fetch(
            new Request(`https://app.example/_lunora/admin/scheduled/ws?token=${encodeURIComponent(minted.token)}`, { headers: { Upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(403);
        expect(calls).toEqual([]);
    });
});

describe("createWorker — requireEphemeralWsToken enforcement (phase 3)", () => {
    const SCHEDULED_WS_URL = "https://app.example/_lunora/admin/scheduled/ws";

    it("rejects the raw master token in ?token= when the option is on (403)", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, requireEphemeralWsToken: true, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(new Request(`${SCHEDULED_WS_URL}?token=${ADMIN_TOKEN}`, { headers: { Upgrade: "websocket" } }), {}, fakeContext);

        expect(response.status).toBe(403);
        expect(calls).toEqual([]);
    });

    it("still accepts a minted ephemeral token with the option on", async () => {
        expect.assertions(2);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, requireEphemeralWsToken: true, schedulerDO: namespace, shardDO: noopNamespace });
        const minted = await mintWsAdminToken(ADMIN_TOKEN);

        const response = await worker.fetch(
            new Request(`${SCHEDULED_WS_URL}?token=${encodeURIComponent(minted.token)}`, { headers: { Upgrade: "websocket" } }),
            {},
            fakeContext,
        );

        expect(response.status).toBe(200);
        expect(calls).toEqual(["/ws"]);
    });

    it("still accepts the master token in the Authorization HEADER with the option on", async () => {
        expect.assertions(1);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, requireEphemeralWsToken: true, schedulerDO: namespace, shardDO: noopNamespace });

        await worker.fetch(new Request(SCHEDULED_WS_URL, { headers: { Upgrade: "websocket", authorization: `Bearer ${ADMIN_TOKEN}` } }), {}, fakeContext);

        expect(calls).toEqual(["/ws"]);
    });

    it("honors a DISABLING env.LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN when the option is unset", async () => {
        expect.assertions(1);

        const { calls, namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, schedulerDO: namespace, shardDO: noopNamespace });

        await worker.fetch(
            new Request(`${SCHEDULED_WS_URL}?token=${ADMIN_TOKEN}`, { headers: { Upgrade: "websocket" } }),
            { LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN: "off" },
            fakeContext,
        );

        expect(calls).toEqual(["/ws"]);
    });

    it("an explicit option:true wins over a disabling env value", async () => {
        expect.assertions(1);

        const { namespace } = recordingScheduler();
        const worker = createWorker({ adminToken: ADMIN_TOKEN, requireEphemeralWsToken: true, schedulerDO: namespace, shardDO: noopNamespace });

        const response = await worker.fetch(
            new Request(`${SCHEDULED_WS_URL}?token=${ADMIN_TOKEN}`, { headers: { Upgrade: "websocket" } }),
            { LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN: "off" },
            fakeContext,
        );

        expect(response.status).toBe(403);
    });
});
