import { describe, expect, it, vi } from "vitest";

import { buildFcmMessage, createFcmTransport } from "../src/fcm-transport";
import { isGoneError } from "../src/subscriptions/normalize";

const config = { accessToken: "access-token", projectId: "demo-project" };

/** A fetch double that answers each call with the next queued response, and records the bodies sent. */
const scriptedFetch = (...responses: { body: unknown; headers?: Record<string, string>; status: number }[]) => {
    const bodies: { message: Record<string, unknown> }[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { message: Record<string, unknown> });

        const next = responses.shift() ?? { body: {}, status: 200 };

        return Response.json(next.body, { headers: { "Content-Type": "application/json", ...next.headers }, status: next.status });
    });

    return { bodies, fetchMock };
};

const unregistered = {
    body: {
        error: {
            code: 404,
            details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }],
            message: "Requested entity was not found.",
            status: "NOT_FOUND",
        },
    },
    status: 404,
};

describe("createFcmTransport", () => {
    it("sends to the project's messages:send endpoint with the access token", async () => {
        expect.hasAssertions();

        const { fetchMock } = scriptedFetch({ body: { name: "projects/demo-project/messages/1" }, status: 200 });
        const transport = createFcmTransport(config, { fetch: fetchMock });

        await transport.provider.send({ body: "hi", to: "device-token" });

        expect(fetchMock).toHaveBeenCalledWith(
            "https://fcm.googleapis.com/v1/projects/demo-project/messages:send",
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer /u) }), method: "POST" }),
        );
    });

    it("forwards per-platform overrides and maps the common fields onto their platform slots", async () => {
        expect.hasAssertions();

        const { bodies, fetchMock } = scriptedFetch({ body: { name: "projects/demo-project/messages/2" }, status: 200 });
        const transport = createFcmTransport(config, { fetch: fetchMock });

        await transport.provider.send({
            badge: 3,
            body: "Match starts now",
            clickAction: "OPEN_MATCH",
            data: { matchId: 42, live: true },
            fcmOverrides: {
                android: { notification: { channel_id: "live-scores" } },
                apns: { payload: { aps: { category: "MATCH", "thread-id": "m42" } } },
                webpush: { fcm_options: { link: "https://example.com/m/42" } },
            },
            sound: "goal.caf",
            title: "Kickoff",
            to: "device-token",
            ttl: 120,
            urgency: "high",
        });

        const message = bodies[0]?.message as Record<string, unknown>;

        expect(message).toMatchObject({
            android: {
                notification: { channel_id: "live-scores", click_action: "OPEN_MATCH", sound: "goal.caf" },
                priority: "HIGH",
                ttl: "120s",
            },
            apns: { payload: { aps: { badge: 3, category: "MATCH", sound: "goal.caf", "thread-id": "m42" } } },
            data: { live: "true", matchId: "42" },
            notification: { body: "Match starts now", title: "Kickoff" },
            token: "device-token",
            webpush: { fcm_options: { link: "https://example.com/m/42" } },
        });
    });

    it("leaves out platform blocks it has nothing for", async () => {
        expect.hasAssertions();

        const { bodies, fetchMock } = scriptedFetch({ body: { name: "projects/demo-project/messages/3" }, status: 200 });

        await createFcmTransport(config, { fetch: fetchMock }).provider.send({ body: "", data: undefined, to: "device-token" });

        expect(Object.keys(bodies[0]?.message ?? {})).toStrictEqual(["token"]);
    });

    it("reports a dead token as UNREGISTERED, which the classifier prunes", async () => {
        expect.hasAssertions();

        const { fetchMock } = scriptedFetch(unregistered);
        const result = await createFcmTransport(config, { fetch: fetchMock }).provider.send({ body: "hi", to: "dead-token" });

        expect(result.success).toBe(false);

        const message = result.success ? "" : (result.error as Error).message;

        expect(message).toBe("FCM 404 UNREGISTERED: Requested entity was not found.");
        expect(isGoneError(message, "fcm")).toBe(true);
    });

    it("does not treat a bare NOT_FOUND as a dead token, and does not retry it", async () => {
        expect.hasAssertions();

        const { fetchMock } = scriptedFetch({
            body: { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } },
            status: 404,
        });
        const result = await createFcmTransport(config, { fetch: fetchMock, retryBaseDelay: 0 }).provider.send({ body: "hi", to: "token" });

        expect(result.success).toBe(false);

        const message = result.success ? "" : (result.error as Error).message;

        expect(message).toBe("FCM 404 NOT_FOUND: Requested entity was not found.");
        expect(isGoneError(message, "fcm")).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries a 429 on a direct topic send and succeeds on the next attempt", async () => {
        expect.hasAssertions();

        const { fetchMock } = scriptedFetch(
            { body: { error: { message: "slow down", status: "RESOURCE_EXHAUSTED" } }, headers: { "retry-after": "0" }, status: 429 },
            { body: { name: "projects/demo-project/messages/4" }, status: 200 },
        );
        const transport = createFcmTransport(config, { fetch: fetchMock, retryBaseDelay: 0 });

        await expect(transport.sendTo({ topic: "news" }, { body: "hi" })).resolves.toBe("projects/demo-project/messages/4");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not retry a 5xx on a direct topic send, because FCM may have accepted it", async () => {
        expect.hasAssertions();

        const { fetchMock } = scriptedFetch({ body: { error: { message: "down", status: "UNAVAILABLE" } }, status: 503 });
        const transport = createFcmTransport(config, { fetch: fetchMock, retryBaseDelay: 0 });

        await expect(transport.sendTo({ topic: "news" }, { body: "hi" })).rejects.toThrow(/UNAVAILABLE/u);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not retry a timed-out topic send, because the audience may already have it", async () => {
        expect.hasAssertions();

        const signals: unknown[] = [];
        const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            signals.push(init?.signal);

            throw new Error("The operation was aborted due to timeout");
        });
        const transport = createFcmTransport(config, { fetch: fetchMock as unknown as typeof fetch, retryBaseDelay: 0 });

        await expect(transport.sendTo({ topic: "news" }, { body: "hi" })).rejects.toThrow(/timeout/u);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // The request is bounded by a timeout signal. This runs under Node; the Workers runtime is not exercised by this suite.
        expect(signals[0]).toBeInstanceOf(AbortSignal);
    });

    it("gives up after the retry budget on a persistent 429 of a direct topic send", async () => {
        expect.hasAssertions();

        const refused = { body: { error: { message: "quota", status: "RESOURCE_EXHAUSTED" } }, headers: { "retry-after": "0" }, status: 429 };
        const { fetchMock } = scriptedFetch(refused, refused, refused, refused);
        const transport = createFcmTransport(config, { fetch: fetchMock, retryBaseDelay: 0 });

        await expect(transport.sendTo({ topic: "news" }, { body: "hi" })).rejects.toThrow(/RESOURCE_EXHAUSTED/u);
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("makes one POST per engine attempt, leaving retries to the engine middleware", async () => {
        expect.hasAssertions();

        const { fetchMock } = scriptedFetch({ body: { error: { message: "down", status: "UNAVAILABLE" } }, status: 503 });
        const result = await createFcmTransport(config, { fetch: fetchMock, retryBaseDelay: 0 }).provider.send({ body: "hi", to: "token" });

        expect(result.success).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("reads a 2xx without a message name as a failure, not a sent message", async () => {
        expect.hasAssertions();

        const { fetchMock } = scriptedFetch({ body: { unexpected: true }, status: 200 });
        const result = await createFcmTransport(config, { fetch: fetchMock }).provider.send({ body: "hi", to: "token" });

        expect(result.success).toBe(false);
    });

    it("refuses an oversized response instead of buffering it", async () => {
        expect.hasAssertions();

        const huge = new Response("x".repeat(70 * 1024), { status: 200 });
        const fetchMock = vi.fn(async () => huge);
        const result = await createFcmTransport(config, { fetch: fetchMock as unknown as typeof fetch }).provider.send({ body: "hi", to: "token" });

        expect(result.success).toBe(false);
    });

    it("rejects an invalid TTL before a request is made", async () => {
        expect.hasAssertions();

        const fetchMock = vi.fn();
        const result = await createFcmTransport(config, { fetch: fetchMock as unknown as typeof fetch }).provider.send({ body: "hi", to: "token", ttl: -1 });

        expect(result.success).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reports a missing credential as a send failure rather than sending an empty bearer", async () => {
        expect.hasAssertions();

        const fetchMock = vi.fn();
        const result = await createFcmTransport({ projectId: "demo-project" }, { fetch: fetchMock as unknown as typeof fetch }).provider.send({
            body: "hi",
            to: "token",
        });

        expect(result.success).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends to a topic and to a condition, without a token", async () => {
        expect.hasAssertions();

        const { bodies, fetchMock } = scriptedFetch(
            { body: { name: "projects/demo-project/messages/5" }, status: 200 },
            { body: { name: "projects/demo-project/messages/6" }, status: 200 },
        );
        const transport = createFcmTransport(config, { fetch: fetchMock });

        await expect(transport.sendTo({ topic: "news" }, { body: "Breaking", title: "News" })).resolves.toBe("projects/demo-project/messages/5");
        await expect(transport.sendTo({ condition: "'sports' in topics" }, { body: "Score" })).resolves.toBe("projects/demo-project/messages/6");

        expect(bodies[0]?.message).toMatchObject({ notification: { body: "Breaking", title: "News" }, topic: "news" });
        expect(bodies[1]?.message).toMatchObject({ condition: "'sports' in topics" });
    });

    it("rejects a malformed topic or an empty condition before any request", async () => {
        expect.hasAssertions();

        const fetchMock = vi.fn();
        const transport = createFcmTransport(config, { fetch: fetchMock as unknown as typeof fetch });

        await expect(transport.sendTo({ topic: "bad topic!" }, { body: "x" })).rejects.toThrow(/FCM topic/u);
        await expect(transport.sendTo({ condition: "  " }, { body: "x" })).rejects.toThrow(/non-empty/u);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("leaves data-only pushes free of an empty Android notification and an empty aps", () => {
        expect.hasAssertions();

        // Assert on the wire body: an absent block is an undefined key in memory and is dropped by JSON.
        // eslint-disable-next-line unicorn/prefer-structured-clone -- JSON drops undefined keys, which is the wire behaviour under test
        const wire = JSON.parse(JSON.stringify(buildFcmMessage({ body: "", data: { sync: "1" }, ttl: 60 }, { token: "t" }))) as Record<string, unknown>;

        expect(wire).not.toHaveProperty("notification");
        expect(wire).toMatchObject({ android: { ttl: "60s" } });
        expect(wire.android).not.toHaveProperty("notification");
        // The TTL still sets the APNs expiry header, which is delivery policy. No APNs payload (the alert) is sent.
        expect(wire).toMatchObject({ apns: { headers: { "apns-expiration": expect.any(String) } } });
        expect(wire.apns).not.toHaveProperty("payload");
    });

    it("sends TTL and urgency to APNs and Web Push as well as Android", () => {
        expect.hasAssertions();

        const message = buildFcmMessage({ body: "x", ttl: 90, urgency: "high" }, { token: "t" });

        expect(message).toMatchObject({
            android: { priority: "HIGH", ttl: "90s" },
            apns: { headers: { "apns-priority": "10" } },
            webpush: { headers: { TTL: "90", Urgency: "high" } },
        });
        expect((message.apns as { headers: Record<string, string> }).headers["apns-expiration"]).toMatch(/^\d+$/u);
    });

    it("lets fcmOverrides win over the headers derived from ttl and urgency", () => {
        expect.hasAssertions();

        const message = buildFcmMessage({ body: "x", fcmOverrides: { webpush: { headers: { TTL: "5" } } }, ttl: 90 }, { token: "t" });

        expect(message).toMatchObject({ webpush: { headers: { TTL: "5" } } });
    });

    it("honours a short Retry-After before the next attempt", async () => {
        expect.hasAssertions();

        const { fetchMock } = scriptedFetch(
            { body: { error: { message: "slow down", status: "RESOURCE_EXHAUSTED" } }, headers: { "retry-after": "0" }, status: 429 },
            { body: { name: "projects/demo-project/messages/20" }, status: 200 },
        );

        await expect(createFcmTransport(config, { fetch: fetchMock, retryBaseDelay: 0 }).sendTo({ topic: "news" }, { body: "x" })).resolves.toBe(
            "projects/demo-project/messages/20",
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("fails rather than wait out a Retry-After longer than the transport will hold open", async () => {
        expect.hasAssertions();

        const { fetchMock } = scriptedFetch({
            body: { error: { message: "later", status: "RESOURCE_EXHAUSTED" } },
            headers: { "retry-after": "3600" },
            status: 429,
        });

        await expect(createFcmTransport(config, { fetch: fetchMock, retryBaseDelay: 0 }).sendTo({ topic: "news" }, { body: "x" })).rejects.toThrow(
            /RESOURCE_EXHAUSTED/u,
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries a 429 whose body cannot be read on a topic send", async () => {
        expect.hasAssertions();

        const unreadable = () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.error(new Error("connection reset"));
                    },
                }),
                { status: 429 },
            );
        const fetchMock = vi
            .fn()
            .mockImplementationOnce(async () => unreadable())
            .mockImplementationOnce(async () => Response.json({ name: "projects/demo-project/messages/21" }));

        await expect(
            createFcmTransport(config, { fetch: fetchMock as unknown as typeof fetch, retryBaseDelay: 0 }).sendTo({ topic: "news" }, { body: "x" }),
        ).resolves.toBe("projects/demo-project/messages/21");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("honours the FcmConfig retries when they are set", async () => {
        expect.hasAssertions();

        const refused = { body: { error: { message: "quota", status: "RESOURCE_EXHAUSTED" } }, headers: { "retry-after": "0" }, status: 429 };
        const { fetchMock } = scriptedFetch(refused, refused);

        await expect(
            createFcmTransport({ ...config, retries: 1 }, { fetch: fetchMock, retryBaseDelay: 0 }).sendTo({ topic: "news" }, { body: "x" }),
        ).rejects.toThrow(/RESOURCE_EXHAUSTED/u);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("names a non-JSON error body by its status, without an error code", async () => {
        expect.hasAssertions();

        const fetchMock = vi.fn(async () => new Response("<html>gateway</html>", { status: 400 }));
        const result = await createFcmTransport(config, { fetch: fetchMock as unknown as typeof fetch }).provider.send({ body: "hi", to: "token" });

        expect(result.success).toBe(false);
        expect(result.success ? "" : (result.error as Error).message).toBe("FCM 400 ERROR: request failed");
    });

    it("reads a response with no body as an empty failure", async () => {
        expect.hasAssertions();

        const fetchMock = vi.fn(async () => new Response(null, { status: 400 }));
        const result = await createFcmTransport(config, { fetch: fetchMock as unknown as typeof fetch }).provider.send({ body: "hi", to: "token" });

        expect(result.success).toBe(false);
    });

    it("retries a 429 with no Retry-After header on the backoff alone", async () => {
        expect.hasAssertions();

        const { fetchMock } = scriptedFetch(
            { body: { error: { message: "quota", status: "RESOURCE_EXHAUSTED" } }, status: 429 },
            { body: { name: "projects/demo-project/messages/30" }, status: 200 },
        );

        await expect(createFcmTransport(config, { fetch: fetchMock, retryBaseDelay: 0 }).sendTo({ topic: "news" }, { body: "x" })).resolves.toBe(
            "projects/demo-project/messages/30",
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("treats a Retry-After HTTP date far in the future as too long to hold open", async () => {
        expect.hasAssertions();

        const later = new Date(Date.now() + 3_600_000).toUTCString();
        const { fetchMock } = scriptedFetch({
            body: { error: { message: "later", status: "RESOURCE_EXHAUSTED" } },
            headers: { "retry-after": later },
            status: 429,
        });

        await expect(createFcmTransport(config, { fetch: fetchMock, retryBaseDelay: 0 }).sendTo({ topic: "news" }, { body: "x" })).rejects.toThrow(
            /wait limit/u,
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries when a Retry-After HTTP date has already passed", async () => {
        expect.hasAssertions();

        const past = new Date(Date.now() - 60_000).toUTCString();
        const { fetchMock } = scriptedFetch(
            { body: { error: { message: "quota", status: "RESOURCE_EXHAUSTED" } }, headers: { "retry-after": past }, status: 429 },
            { body: { name: "projects/demo-project/messages/31" }, status: 200 },
        );

        await expect(createFcmTransport(config, { fetch: fetchMock, retryBaseDelay: 0 }).sendTo({ topic: "news" }, { body: "x" })).resolves.toBe(
            "projects/demo-project/messages/31",
        );
    });

    it("ignores an unreadable Retry-After and retries on the backoff", async () => {
        expect.hasAssertions();

        const { fetchMock } = scriptedFetch(
            { body: { error: { message: "quota", status: "RESOURCE_EXHAUSTED" } }, headers: { "retry-after": "soon" }, status: 429 },
            { body: { name: "projects/demo-project/messages/32" }, status: 200 },
        );

        await expect(createFcmTransport(config, { fetch: fetchMock, retryBaseDelay: 0 }).sendTo({ topic: "news" }, { body: "x" })).resolves.toBe(
            "projects/demo-project/messages/32",
        );
    });

    it("fails a device send after one connection error, leaving the retry to the engine", async () => {
        expect.hasAssertions();

        const fetchMock = vi.fn(async () => {
            throw new Error("connection reset");
        });
        const result = await createFcmTransport(config, { fetch: fetchMock as unknown as typeof fetch, retryBaseDelay: 0 }).provider.send({
            body: "x",
            to: "token",
        });

        expect(result.success).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects a send with no project id before any request", async () => {
        expect.hasAssertions();

        const fetchMock = vi.fn();
        const transport = createFcmTransport({ accessToken: "access-token", projectId: "" }, { fetch: fetchMock as unknown as typeof fetch });

        await expect(transport.sendTo({ topic: "news" }, { body: "x" })).rejects.toThrow(/projectId/u);

        const result = await transport.provider.send({ body: "x", to: "token" });

        expect(result.success).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends with the token from getAccessToken", async () => {
        expect.hasAssertions();

        const fetchMock = vi.fn(async () => Response.json({ name: "projects/demo-project/messages/34" }));
        const transport = createFcmTransport(
            { getAccessToken: async () => "callback-credential", projectId: "demo-project" },
            { fetch: fetchMock as unknown as typeof fetch },
        );

        await transport.sendTo({ topic: "news" }, { body: "x" });

        expect(fetchMock).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringMatching(/callback-credential$/u) }) }),
        );
    });

    it("refuses a send with no credential, and reports availability from the credential", async () => {
        expect.hasAssertions();

        const fetchMock = vi.fn();
        const bare = createFcmTransport({ projectId: "demo-project" }, { fetch: fetchMock as unknown as typeof fetch });

        await expect(bare.sendTo({ topic: "news" }, { body: "x" })).rejects.toThrow(/access token/u);
        expect(bare.provider.isAvailable()).toBe(false);
        expect(createFcmTransport(config).provider.isAvailable()).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("maps a low urgency to normal Android priority and APNs priority 5", () => {
        expect.hasAssertions();

        const message = buildFcmMessage({ body: "x", ttl: 10, urgency: "low" }, { token: "t" });

        expect(message).toMatchObject({ android: { priority: "NORMAL" }, apns: { headers: { "apns-priority": "5" } } });
    });

    it("sends each token of a multi-token payload as its own message", async () => {
        expect.hasAssertions();

        const { fetchMock } = scriptedFetch(
            { body: { name: "projects/demo-project/messages/35" }, status: 200 },
            { body: { name: "projects/demo-project/messages/36" }, status: 200 },
        );
        const result = await createFcmTransport(config, { fetch: fetchMock }).provider.send({ body: "x", to: ["token-a", "token-b"] });

        expect(result.success).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("waits out a device refusal's Retry-After before reporting the failure", async () => {
        expect.hasAssertions();

        vi.useFakeTimers();

        try {
            const { fetchMock } = scriptedFetch({
                body: { error: { message: "quota", status: "RESOURCE_EXHAUSTED" } },
                headers: { "retry-after": "1" },
                status: 429,
            });
            let settled = false;
            const pending = Promise.resolve(createFcmTransport(config, { fetch: fetchMock }).provider.send({ body: "x", to: "token" }));

            const observed = pending.then((result) => {
                settled = true;

                return result;
            });

            await vi.advanceTimersByTimeAsync(999);

            expect(settled).toBe(false);

            await vi.advanceTimersByTimeAsync(1);

            expect(settled).toBe(true);

            const result = await observed;

            expect(result.success).toBe(false);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("sends a topic when the configured retry count is not a number", async () => {
        expect.hasAssertions();

        const { fetchMock } = scriptedFetch({ body: { name: "projects/demo-project/messages/40" }, status: 200 });

        await expect(createFcmTransport({ ...config, retries: Number.NaN }, { fetch: fetchMock }).sendTo({ topic: "news" }, { body: "x" })).resolves.toBe(
            "projects/demo-project/messages/40",
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not name a dead token from a status of UNREGISTERED without the detail", async () => {
        expect.hasAssertions();

        const fetchMock = vi.fn(async () => Response.json({ error: { message: "gone", status: "UNREGISTERED" } }, { status: 404 }));
        const result = await createFcmTransport(config, { fetch: fetchMock as unknown as typeof fetch }).provider.send({ body: "x", to: "token" });

        expect(result.success ? "" : (result.error as Error).message).toBe("FCM 404 ERROR: gone");
    });

    it("leaves APNs priority to APNs' own default for a normal-urgency send", () => {
        expect.hasAssertions();

        const message = buildFcmMessage({ body: "x", ttl: 10, urgency: "normal" }, { token: "t" });

        expect(message).toMatchObject({ apns: { headers: { "apns-expiration": expect.any(String) } } });
        expect((message.apns as { headers: Record<string, string | undefined> }).headers["apns-priority"]).toBeUndefined();
    });

    it("names a refusal from its readable fields, not as [object Object]", async () => {
        expect.hasAssertions();

        const fetchMock = vi.fn(async () => Response.json({ error: { message: { reason: "malformed" }, status: { code: 3 } } }, { status: 400 }));
        const result = await createFcmTransport(config, { fetch: fetchMock as unknown as typeof fetch }).provider.send({ body: "x", to: "token" });
        const message = result.success ? "" : (result.error as Error).message;

        expect(message).toBe("FCM 400 ERROR: request failed");
        expect(message).not.toContain("[object Object]");
    });

    it("does not hold a topic send open for a Retry-After it will not retry", async () => {
        expect.hasAssertions();

        vi.useFakeTimers();

        try {
            const { fetchMock } = scriptedFetch({
                body: { error: { message: "quota", status: "RESOURCE_EXHAUSTED" } },
                headers: { "retry-after": "1" },
                status: 429,
            });
            const transport = createFcmTransport({ ...config, retries: 0 }, { fetch: fetchMock });
            const outcome = transport.sendTo({ topic: "news" }, { body: "x" }).then(
                () => "resolved",
                () => "rejected",
            );

            // No timer is advanced: a failure that waited for the Retry-After would still be pending here.
            await vi.advanceTimersByTimeAsync(0);

            await expect(outcome).resolves.toBe("rejected");
        } finally {
            vi.useRealTimers();
        }
    });

    it("applies the Retry-After limit to a throttled response whose body cannot be read", async () => {
        expect.hasAssertions();

        const unreadable = () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.error(new Error("connection reset"));
                    },
                }),
                { headers: { "retry-after": "3600" }, status: 429 },
            );
        const fetchMock = vi.fn(async () => unreadable());
        const transport = createFcmTransport(config, { fetch: fetchMock as unknown as typeof fetch, retryBaseDelay: 0 });

        await expect(transport.sendTo({ topic: "news" }, { body: "x" })).rejects.toThrow(/wait limit/u);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not double the slash when the configured endpoint ends in one", async () => {
        expect.hasAssertions();

        const { fetchMock } = scriptedFetch({ body: { name: "projects/demo-project/messages/50" }, status: 200 });
        const transport = createFcmTransport({ ...config, endpoint: "https://fcm.example.test/" }, { fetch: fetchMock });

        await transport.sendTo({ topic: "news" }, { body: "x" });

        expect(fetchMock).toHaveBeenCalledWith("https://fcm.example.test/v1/projects/demo-project/messages:send", expect.anything());
    });

    it("caps each retry delay, so a large retry count never asks a timer for more than the cap", async () => {
        expect.hasAssertions();

        const delays: number[] = [];
        const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
            delays.push(delay ?? 0);
            callback();

            return 0;
        }) as unknown as typeof setTimeout);

        try {
            const refused = { body: { error: { message: "quota", status: "RESOURCE_EXHAUSTED" } }, status: 429 };
            const { fetchMock } = scriptedFetch(refused, refused, refused, refused, refused, refused);

            await expect(
                createFcmTransport({ ...config, retries: 5 }, { fetch: fetchMock, retryBaseDelay: 1_000_000_000 }).sendTo({ topic: "news" }, { body: "x" }),
            ).rejects.toThrow(/RESOURCE_EXHAUSTED/u);
            expect(delays.length).toBeGreaterThan(0);
            expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
        } finally {
            timers.mockRestore();
        }
    });

    it("reports no provider available for an empty access token", () => {
        expect.hasAssertions();

        expect(createFcmTransport({ accessToken: "", projectId: "demo-project" }).provider.isAvailable()).toBe(false);
        expect(createFcmTransport({ getAccessToken: async () => "callback-credential", projectId: "demo-project" }).provider.isAvailable()).toBe(true);
    });

    it("reports a retryable failure for a group whose first token is gone, so the others can be retried", async () => {
        expect.hasAssertions();

        const fetchMock = vi
            .fn()
            .mockImplementationOnce(async () =>
                Response.json({ error: { details: [{ errorCode: "UNREGISTERED" }], message: "gone", status: "NOT_FOUND" } }, { status: 404 }),
            )
            .mockImplementationOnce(async () => Response.json({ error: { message: "busy", status: "UNAVAILABLE" } }, { status: 503 }));
        const result = await createFcmTransport(config, { fetch: fetchMock as unknown as typeof fetch, retryBaseDelay: 0 }).provider.send({
            body: "x",
            to: ["gone-token", "busy-token"],
        });

        expect(result.success).toBe(false);
        expect(result.success ? "" : (result.error as Error).message).toContain("FCM 503");
    });
});
