import { describe, expect, it, vi } from "vitest";

import { createFcmTransport } from "../src/fcm-transport";
import { isGoneError } from "../src/subscriptions/normalize";

const config = { accessToken: "access-token", projectId: "demo-project" };

/** A fetch double that answers each call with the next queued response, and records the bodies sent. */
const scriptedFetch = (...responses: { body: unknown; status: number }[]) => {
    const bodies: { message: Record<string, unknown> }[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { message: Record<string, unknown> });

        const next = responses.shift() ?? { body: {}, status: 200 };

        return Response.json(next.body, { headers: { "Content-Type": "application/json" }, status: next.status });
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
                priority: "high",
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

    it("retries a 503 on a direct topic send and succeeds on the next attempt", async () => {
        expect.hasAssertions();

        const { fetchMock } = scriptedFetch(
            { body: { error: { message: "backend unavailable", status: "UNAVAILABLE" } }, status: 503 },
            { body: { name: "projects/demo-project/messages/4" }, status: 200 },
        );
        const transport = createFcmTransport(config, { fetch: fetchMock, retryBaseDelay: 0 });

        await expect(transport.sendTo({ topic: "news" }, { body: "hi" })).resolves.toBe("projects/demo-project/messages/4");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("gives up after the retry budget on a persistent 5xx of a direct topic send", async () => {
        expect.hasAssertions();

        const down = { body: { error: { message: "down", status: "UNAVAILABLE" } }, status: 503 };
        const { fetchMock } = scriptedFetch(down, down, down, down);
        const transport = createFcmTransport(config, { fetch: fetchMock, retryBaseDelay: 0 });

        await expect(transport.sendTo({ topic: "news" }, { body: "hi" })).rejects.toThrow(/UNAVAILABLE/u);
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
});
