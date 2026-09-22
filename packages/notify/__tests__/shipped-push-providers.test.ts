import { createFcmProvider } from "@visulima/notification/providers/fcm";
import { createWebPushProvider } from "@visulima/notification/providers/web-push";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What the SHIPPED push providers do with a multi-target send where some targets
 * are accepted and some are not.
 *
 * `routingPushProvider` takes both providers as options, so nothing in this
 * package's own source states this — and the router's in-router group retry
 * (`GROUP_RETRIES`) rests entirely on it. If a partially-accepted send were
 * reported as a FAILURE, re-attempting that group would re-POST every target the
 * provider had already delivered to, which is the exact harm the partial verdict
 * was invented to prevent. These tests drive the real `@visulima/notification`
 * providers over a stubbed `fetch`, so the property is asserted rather than
 * assumed and a dependency bump that changes it fails here instead of in
 * production.
 */

const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** A P-256 keypair in the encodings `createWebPushProvider` wants: raw public point, JWK `d` scalar. */
const vapidKeys = async (): Promise<{ vapidPrivateKey: string; vapidPublicKey: string }> => {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

    return { vapidPrivateKey: jwk.d as string, vapidPublicKey: base64Url(raw) };
};

/** A web-push subscription whose endpoint path decides how the stub answers it. */
const subscription = (path: string, p256dh: string): string =>
    JSON.stringify({ endpoint: `https://push.example/${path}`, keys: { auth: base64Url(new Uint8Array(16).fill(7)), p256dh } });

interface StubbedRequest {
    body: string;
    headers: Record<string, string>;
    url: string;
}

/** Stub `fetch`, answering 200 when `accept` says so and 500 otherwise. Records every request. */
const stubFetch = (accept: (url: string, body: string) => boolean): StubbedRequest[] => {
    const requests: StubbedRequest[] = [];

    vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
        const body = typeof init.body === "string" ? init.body : "";

        requests.push({ body, headers: { ...(init.headers as Record<string, string>) }, url });

        return accept(url, body)
            ? Response.json({ name: "projects/p/messages/1" }, { status: 200 })
            : Response.json({ error: { message: "upstream said no" } }, { status: 500 });
    });

    return requests;
};

/** `retries: 0` so a test that counts SENDS is not reading the provider's own per-POST retry. */
const fcmProvider = () => createFcmProvider({ accessToken: "token", projectId: "project", retries: 0, timeout: 2000 }); // gitleaks:allow -- the literal string "token"; the provider never authenticates here, `fetch` is stubbed

const webPushProvider = (keys: { vapidPrivateKey: string; vapidPublicKey: string }) =>
    createWebPushProvider({ ...keys, timeout: 2000, vapidSubject: "mailto:a@b.c" });

describe("shipped push providers", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe("fCM, multi-target send", () => {
        it("reports SUCCESS when at least one target was accepted", async () => {
            expect.hasAssertions();

            stubFetch((_url, body) => (JSON.parse(body) as { message: { token: string } }).message.token === "good");

            const result = await fcmProvider().send({ body: "b", title: "t", to: ["good", "bad"] });

            // The load-bearing half of `GROUP_RETRIES`: a group holding one
            // delivered target is NOT a failure, so the router never re-attempts
            // it and cannot re-POST the target that already got the push.
            expect(result.success).toBe(true);
            expect(result.data?.recipients?.map((recipient) => [recipient.id, recipient.status])).toStrictEqual([
                ["good", "sent"],
                ["bad", "failed"],
            ]);
        });

        it("reports FAILURE only when every target failed", async () => {
            expect.hasAssertions();

            stubFetch(() => false);

            const result = await fcmProvider().send({ body: "b", title: "t", to: ["bad", "worse"] });

            expect(result.success).toBe(false);
        });

        it("retries each POST itself, so one router attempt is up to four requests", async () => {
            expect.hasAssertions();

            const requests = stubFetch(() => false);

            // The provider default, which is what `buildEngine` wires: `retries: 3`.
            await createFcmProvider({ accessToken: "token", projectId: "project", timeout: 2000 }).send({ body: "b", title: "t", to: ["bad"] }); // gitleaks:allow -- the literal string "token"; the provider never authenticates here, `fetch` is stubbed

            // One POST plus three retries. Four router attempts are therefore up
            // to sixteen POSTs on FCM — the arithmetic `GROUP_RETRIES` documents.
            expect(requests).toHaveLength(4);
        });

        it("sends no collapse or topic key, so a re-attempt cannot coalesce with the first", async () => {
            expect.hasAssertions();

            const requests = stubFetch(() => true);

            await fcmProvider().send({ body: "b", title: "t", to: ["good"] });

            // The whole body, not a key probe: a `collapse_key` or a `topic`
            // added later has to fail here rather than pass unnoticed.
            expect(JSON.parse(requests[0]?.body ?? "{}")).toStrictEqual({ message: { notification: { body: "b", title: "t" }, token: "good" } });
        });
    });

    describe("web push, multi-target send", () => {
        it("reports SUCCESS when at least one target was accepted", async () => {
            expect.hasAssertions();

            const keys = await vapidKeys();

            stubFetch((url) => url.endsWith("/ok"));

            const result = await webPushProvider(keys).send({
                body: "b",
                title: "t",
                to: [subscription("ok", keys.vapidPublicKey), subscription("bad", keys.vapidPublicKey)],
            });

            expect(result.success).toBe(true);
            expect(result.data?.recipients?.map((recipient) => recipient.status)).toStrictEqual(["sent", "failed"]);
        });

        it("reports FAILURE only when every target failed", async () => {
            expect.hasAssertions();

            const keys = await vapidKeys();

            stubFetch(() => false);

            const result = await webPushProvider(keys).send({
                body: "b",
                title: "t",
                to: [subscription("bad", keys.vapidPublicKey), subscription("worse", keys.vapidPublicKey)],
            });

            expect(result.success).toBe(false);
        });

        it("does not retry a POST itself, and sends no Topic header", async () => {
            expect.hasAssertions();

            const keys = await vapidKeys();
            const requests = stubFetch(() => false);

            await webPushProvider(keys).send({ body: "b", title: "t", to: subscription("bad", keys.vapidPublicKey) });

            // One POST per target per router attempt — four router attempts are
            // four POSTs on web push, against FCM's sixteen.
            expect(requests).toHaveLength(1);

            // No `Topic`: a re-attempt is a fresh notification to the user agent,
            // it cannot replace the first one. Same exposure on both transports.
            expect(Object.keys(requests[0]?.headers ?? {}).map((header) => header.toLowerCase())).not.toContain("topic");
        });
    });
});
