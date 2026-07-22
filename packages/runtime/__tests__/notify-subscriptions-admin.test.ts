import { describe, expect, it } from "vitest";

import type { ExecutionContextLike, NotifySubscriptionStoreLike } from "../src/create-worker";
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

const ADMIN_TOKEN = "notify-admin-bearer";
const RPC_URL = "https://app.example/_lunora/rpc";
const LIST_OP = "__lunora_admin__:listPushSubscriptions";

/** A store stub carrying the delivery secrets (`keys`, `token`) the RPC must strip. */
const storeWith = (devices: ReadonlyArray<Record<string, unknown>>): NotifySubscriptionStoreLike & { calls: number } => {
    const stub = {
        calls: 0,
        list: async (): Promise<ReadonlyArray<Record<string, unknown>>> => {
            stub.calls += 1;

            return devices;
        },
    };

    return stub as never;
};

const webPushDevice = {
    createdAt: 1,
    endpoint: "https://push.example/ep-1",
    id: "web:1",
    keys: { auth: "AUTH_SECRET", p256dh: "P256_SECRET" },
    kind: "web-push",
    lastSeenAt: 2,
    lastStatus: "ok",
    userId: "user-1",
};

const fcmDevice = {
    createdAt: 3,
    id: "fcm:1",
    kind: "fcm",
    lastError: "UNREGISTERED",
    lastSeenAt: 4,
    lastStatus: "failed",
    token: "FCM_DEVICE_TOKEN",
    userId: "user-2",
};

const listRequest = (options: { args?: Record<string, unknown>; token?: string } = {}): Request => {
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (options.token !== undefined) {
        headers["authorization"] = `Bearer ${options.token}`;
    }

    return new Request(RPC_URL, {
        body: JSON.stringify({ args: options.args ?? {}, functionPath: LIST_OP }),
        headers,
        method: "POST",
    });
};

describe("createWorker — __lunora_admin__:listPushSubscriptions", () => {
    it("returns the registered devices for an admin, with delivery secrets stripped", async () => {
        expect.assertions(5);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            notifySubscriptionStore: storeWith([webPushDevice, fcmDevice]),
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(listRequest({ token: ADMIN_TOKEN }), {}, fakeContext);

        expect(response.status).toBe(200);

        const body: { subscriptions: Record<string, unknown>[] } = await response.json();

        expect(body.subscriptions).toHaveLength(2);
        // The endpoint/kind/status are surfaced…
        expect(body.subscriptions[0]).toMatchObject({ endpoint: "https://push.example/ep-1", kind: "web-push", lastStatus: "ok" });
        // …but the Web Push encryption keys and the FCM token are NEVER sent.
        expect(body.subscriptions.some((device) => "keys" in device || "token" in device)).toBe(false);
        expect(JSON.stringify(body)).not.toContain("SECRET");
    });

    it("narrows the result to a requested { kind }", async () => {
        expect.assertions(2);

        const worker = createWorker({
            adminToken: ADMIN_TOKEN,
            notifySubscriptionStore: storeWith([webPushDevice, fcmDevice]),
            shardDO: noopNamespace,
        });

        const response = await worker.fetch(listRequest({ args: { kind: "fcm" }, token: ADMIN_TOKEN }), {}, fakeContext);
        const body: { subscriptions: Record<string, unknown>[] } = await response.json();

        expect(body.subscriptions).toHaveLength(1);
        expect(body.subscriptions[0]).toMatchObject({ id: "fcm:1", kind: "fcm" });
    });

    it("is default-closed: a non-admin request is FORBIDDEN (403) and reads no devices", async () => {
        expect.assertions(3);

        const store = storeWith([webPushDevice]);
        const worker = createWorker({ adminToken: ADMIN_TOKEN, notifySubscriptionStore: store, shardDO: noopNamespace });

        const response = await worker.fetch(listRequest({ token: "wrong-token" }), {}, fakeContext);

        expect(response.status).toBe(403);

        const body: { error?: { code?: string } } = await response.json();

        expect(body.error?.code).toBe("ADMIN_FORBIDDEN");
        // The store must never be consulted for an unauthorized caller.
        expect(store.calls).toBe(0);
    });

    it("returns an empty device list gracefully when no notify store is configured", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(listRequest({ token: ADMIN_TOKEN }), {}, fakeContext);

        expect(response.status).toBe(200);

        const body: { subscriptions: unknown[] } = await response.json();

        expect(body.subscriptions).toStrictEqual([]);
    });
});
