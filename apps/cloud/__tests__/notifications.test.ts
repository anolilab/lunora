import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { randomSecret } from "../src/deploy/keys";
import type { NotificationRequest } from "../src/notifications/deliver";
import { deliverNotification, invalidDestinationReason, maskDestination, notificationRequestFor, signWebhookBody } from "../src/notifications/deliver";
import type { NotificationEvent } from "../src/notifications/events";
import { channelsForEvent, isNotificationEvent, renderNotification } from "../src/notifications/events";
import { MAX_ATTEMPTS, RETENTION_MS, retryDelayMs, runNotificationSweep } from "../src/notifications/sweep";
import { encryptSecret } from "../src/secrets/crypto";
import type { ControlPlaneDb } from "../src/store";

const NOW = 1_700_000_000_000;

const message = renderNotification("deployment.live", { detail: "Version 3 is live at https://app.example.com.", project: "Acme" });

describe(renderNotification, () => {
    it("names the event and project in the subject and carries the detail line in the body", () => {
        expect(message).toStrictEqual({
            body: 'Deployment live for "Acme" on Lunora Cloud.\nVersion 3 is live at https://app.example.com.',
            event: "deployment.live",
            subject: "[Lunora] Deployment live: Acme",
        });
    });

    it("omits the detail line when there is none", () => {
        expect(renderNotification("domain.verified", { project: "Acme" }).body).toBe('Domain verified for "Acme" on Lunora Cloud.');
    });

    it("labels a failed domain", () => {
        expect(renderNotification("domain.failed", { project: "Acme" }).subject).toBe("[Lunora] Domain failed: Acme");
    });
});

describe(channelsForEvent, () => {
    it("selects only enabled channels subscribed to the event", () => {
        const channels = [
            { _id: "a", enabled: true, events: ["deployment.live"] as NotificationEvent[] },
            { _id: "b", enabled: false, events: ["deployment.live"] as NotificationEvent[] },
            { _id: "c", enabled: true, events: ["domain.verified"] as NotificationEvent[] },
        ];

        expect(channelsForEvent(channels, "deployment.live").map((channel) => channel._id)).toStrictEqual(["a"]);
    });
});

describe(isNotificationEvent, () => {
    it("accepts only known event names from untrusted input", () => {
        expect(isNotificationEvent("domain.failed")).toBe(true);
        expect(isNotificationEvent("domain.exploded")).toBe(false);
        expect(isNotificationEvent(42)).toBe(false);
    });
});

describe(invalidDestinationReason, () => {
    it("accepts a numeric or @channel telegram chat id only with a stored bot token", () => {
        expect(invalidDestinationReason("telegram", "-1001234567890", true)).toBeNull();
        expect(invalidDestinationReason("telegram", "@my_channel", true)).toBeNull();
        expect(invalidDestinationReason("telegram", "not a chat", true)).not.toBeNull();
        expect(invalidDestinationReason("telegram", "-1001234567890", false)).toBe("telegram needs a bot token");
    });

    it("accepts only discord.com webhook URLs for discord", () => {
        expect(invalidDestinationReason("discord", "https://discord.com/api/webhooks/1/token", false)).toBeNull();
        expect(invalidDestinationReason("discord", "https://evil.example.com/api/webhooks/1/token", false)).not.toBeNull();
        expect(invalidDestinationReason("discord", "https://discord.com/channels/1", false)).not.toBeNull();
    });

    it("requires a public https URL for slack and webhook", () => {
        expect(invalidDestinationReason("slack", "https://hooks.example.com/services/x", false)).toBeNull();
        expect(invalidDestinationReason("webhook", "http://hooks.example.com/x", true)).not.toBeNull();
        expect(invalidDestinationReason("webhook", "https://localhost/x", true)).not.toBeNull();
    });
});

describe(signWebhookBody, () => {
    it("is HMAC-SHA256 over the timestamp, a dot, and the body", async () => {
        const key = randomSecret();
        const expected = createHmac("sha256", key).update('1700000000.{"a":1}').digest("hex");

        await expect(signWebhookBody(key, 1_700_000_000, '{"a":1}')).resolves.toBe(expected);
    });
});

describe(notificationRequestFor, () => {
    it("suppresses every mention on discord and truncates over-long content", async () => {
        const long = renderNotification("test", { detail: "x".repeat(5000), project: "Acme" });
        const request = await notificationRequestFor({ destination: "https://discord.com/api/webhooks/1/t", kind: "discord" }, long, 1);
        const payload = JSON.parse(request.body) as { allowed_mentions: { parse: string[] }; content: string };

        expect(payload.allowed_mentions).toStrictEqual({ parse: [] });
        expect(payload.content.length).toBeLessThanOrEqual(1900);
    });

    it("puts the bot token in the telegram URL and sends plain text with no parse mode", async () => {
        const token = randomSecret();
        const request = await notificationRequestFor({ destination: "-100123", kind: "telegram", secret: token }, message, 1);
        const payload = JSON.parse(request.body) as Record<string, unknown>;

        expect(request.url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
        expect(payload).not.toHaveProperty("parse_mode");
        expect(payload.chat_id).toBe("-100123");
    });

    it("signs a generic webhook with Unix seconds, so a receiver can verify the timestamp and body", async () => {
        // `now` is epoch milliseconds (Date.now()); the signed timestamp is seconds.
        const now = 1_700_000_000_123;
        const key = randomSecret();
        const request = await notificationRequestFor({ destination: "https://hooks.example.com/x", kind: "webhook", secret: key }, message, now);
        const expected = createHmac("sha256", key).update(`1700000000.${request.body}`).digest("hex");

        expect(request.headers["lunora-signature"]).toBe(`t=1700000000,v1=${expected}`);
        expect(JSON.parse(request.body)).toMatchObject({ event: "deployment.live", timestamp: 1_700_000_000 });
    });
});

describe(maskDestination, () => {
    it("keeps the host and the last four characters of a URL, and shows a telegram chat id whole", () => {
        expect(maskDestination("slack", "https://hooks.slack.com/services/T000/B000/secretsecret")).toBe("https://hooks.slack.com/…cret");
        expect(maskDestination("telegram", "-1001234567890")).toBe("-1001234567890");
    });
});

describe(deliverNotification, () => {
    const request: NotificationRequest = { body: "{}", headers: {}, url: "https://hooks.example.com/x" };

    it("refuses an unsafe URL without fetching, and marks it permanent", async () => {
        const fetchSpy = vi.fn<typeof globalThis.fetch>();

        await expect(deliverNotification(fetchSpy, { ...request, url: "http://localhost/x" })).rejects.toMatchObject({
            message: "unsafe notification destination",
            retryable: false,
        });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("treats a redirect or a 4xx as permanent, naming only the status", async () => {
        const fetchSpy = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(null, { status: 302 })));

        await expect(deliverNotification(fetchSpy, request)).rejects.toMatchObject({
            message: "notification endpoint responded 302",
            retryable: false,
        });
        expect(fetchSpy).toHaveBeenCalledWith(request.url, expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }));
    });

    it("treats a 5xx or a 429 as retryable", async () => {
        const serverError = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(null, { status: 503 })));
        const rateLimited = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(null, { status: 429 })));

        await expect(deliverNotification(serverError, request)).rejects.toMatchObject({ retryable: true });
        await expect(deliverNotification(rateLimited, request)).rejects.toMatchObject({ retryable: true });
    });

    it("treats a network error as retryable", async () => {
        const fetchSpy = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new TypeError("fetch failed")));

        await expect(deliverNotification(fetchSpy, request)).rejects.toMatchObject({ retryable: true });
    });
});

describe(retryDelayMs, () => {
    it("doubles from 30 seconds and caps at an hour", () => {
        expect(retryDelayMs(1)).toBe(30_000);
        expect(retryDelayMs(2)).toBe(60_000);
        expect(retryDelayMs(3)).toBe(120_000);
        expect(retryDelayMs(20)).toBe(60 * 60 * 1000);
    });
});

type Row = Record<string, unknown> & { _id: string };

/**
 * A minimal in-memory control-plane store. `where` is exact-match on top-level
 * fields; `orderBy` sorts on its first key; `limit` truncates; `delete` removes.
 */
const fakeDatabase = (tables: Record<string, Row[]>): ControlPlaneDb & { rows: Record<string, Row[]> } => {
    const matches = (row: Row, where: Record<string, unknown> = {}): boolean => Object.entries(where).every(([key, value]) => row[key] === value);

    return {
        delete: (id, table) => {
            tables[table ?? ""] = (tables[table ?? ""] ?? []).filter((row) => row._id !== id);

            return Promise.resolve(undefined);
        },
        findMany: (table, args) => {
            const [sortKey] = args?.orderBy?.[0] ? Object.entries(args.orderBy[0]) : [];
            const rows = (tables[table] ?? [])
                .filter((row) => matches(row, args?.where))
                .toSorted((a, b) => (sortKey ? (Number(a[sortKey[0]]) - Number(b[sortKey[0]])) * (sortKey[1] === "desc" ? -1 : 1) : 0));

            return Promise.resolve({ page: args?.limit === undefined ? rows : rows.slice(0, args.limit) });
        },
        insert: () => Promise.resolve(undefined),
        patch: (id, patch, table) => {
            const row = (tables[table ?? ""] ?? []).find((candidate) => candidate._id === id);

            Object.assign(row ?? {}, patch);

            return Promise.resolve(undefined);
        },
        rows: tables,
    };
};

const pending = (id: string, channelId: string, createdAt: number, overrides: Partial<Row> = {}): Row => {
    return {
        _id: id,
        attempts: 0,
        body: "body",
        channelId,
        createdAt,
        event: "deployment.live",
        kind: "slack",
        nextAttemptAt: createdAt,
        organizationId: "org",
        status: "pending",
        subject: "[Lunora] Deployment live: Acme",
        updatedAt: createdAt,
        ...overrides,
    };
};

describe(runNotificationSweep, () => {
    it("delivers, reschedules a retryable failure, and fails a permanent one", async () => {
        const database = fakeDatabase({
            notificationChannels: [
                { _id: "ch1", destination: "https://hooks.example.com/ok", enabled: true, kind: "slack", organizationId: "org" },
                { _id: "ch2", destination: "https://hooks.example.com/down", enabled: true, kind: "slack", organizationId: "org" },
                { _id: "ch3", destination: "https://hooks.example.com/off", enabled: false, kind: "slack", organizationId: "org" },
            ],
            notificationDeliveries: [pending("d1", "ch1", 1), pending("d2", "ch2", 2), pending("d3", "ch3", 3), pending("d4", "gone", 4)],
        });
        const fetchSpy = vi.fn<typeof globalThis.fetch>((url) =>
            Promise.resolve(new Response(null, { status: url === "https://hooks.example.com/down" ? 500 : 204 })),
        );

        const result = await runNotificationSweep(database, { fetch: fetchSpy, now: NOW });

        expect(result).toStrictEqual({ delivered: 1, failed: 2, pruned: 0, retrying: 1 });
        expect(database.rows.notificationDeliveries).toMatchObject([
            { _id: "d1", deliveredAt: NOW, status: "delivered" },
            { _id: "d2", attempts: 1, error: "notification endpoint responded 500", nextAttemptAt: NOW + 30_000, status: "pending" },
            { _id: "d3", error: "channel was disabled before delivery", status: "failed" },
            { _id: "d4", error: "channel was removed", status: "failed" },
        ]);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("leaves rows that are not yet due untouched", async () => {
        const database = fakeDatabase({
            notificationChannels: [{ _id: "ch1", destination: "https://hooks.example.com/ok", enabled: true, kind: "slack", organizationId: "org" }],
            notificationDeliveries: [pending("d1", "ch1", 1, { _id: "d1", nextAttemptAt: NOW + 60_000 })],
        });
        const fetchSpy = vi.fn<typeof globalThis.fetch>();

        const result = await runNotificationSweep(database, { fetch: fetchSpy, now: NOW });

        expect(result).toStrictEqual({ delivered: 0, failed: 0, pruned: 0, retrying: 0 });
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(database.rows.notificationDeliveries[0]).toMatchObject({ status: "pending" });
    });

    it("gives up on a retryable failure once the attempt budget is spent", async () => {
        const database = fakeDatabase({
            notificationChannels: [{ _id: "ch1", destination: "https://hooks.example.com/down", enabled: true, kind: "slack", organizationId: "org" }],
            notificationDeliveries: [pending("d1", "ch1", 1, { _id: "d1", attempts: MAX_ATTEMPTS - 1 })],
        });
        const fetchSpy = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(null, { status: 500 })));

        const result = await runNotificationSweep(database, { fetch: fetchSpy, now: NOW });

        expect(result.failed).toBe(1);
        expect(database.rows.notificationDeliveries[0]).toMatchObject({ attempts: MAX_ATTEMPTS, status: "failed" });
    });

    it("decrypts a sealed channel secret and signs with it", async () => {
        const key = randomSecret();
        const sealed = await encryptSecret(key, "signing-key");
        const database = fakeDatabase({
            notificationChannels: [
                {
                    _id: "ch1",
                    destination: "https://hooks.example.com/hook",
                    enabled: true,
                    kind: "webhook",
                    organizationId: "org",
                    secretCiphertext: sealed.ciphertext,
                    secretIv: sealed.iv,
                },
            ],
            notificationDeliveries: [pending("d1", "ch1", 1, { _id: "d1", kind: "webhook" })],
        });
        const fetchSpy = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(null, { status: 204 })));

        await runNotificationSweep(database, { fetch: fetchSpy, now: NOW, secretKey: key });

        const [, init] = fetchSpy.mock.calls[0] ?? [];
        const headers = init?.headers as Record<string, string>;
        const body = init?.body as string;
        const expected = createHmac("sha256", "signing-key").update(`1700000000.${body}`).digest("hex");

        expect(headers["lunora-signature"]).toBe(`t=1700000000,v1=${expected}`);
        expect(database.rows.notificationDeliveries[0]).toMatchObject({ status: "delivered" });
    });

    it("fails a sealed channel permanently when no encryption key is configured", async () => {
        const sealed = await encryptSecret(randomSecret(), "signing-key");
        const database = fakeDatabase({
            notificationChannels: [
                {
                    _id: "ch1",
                    destination: "https://hooks.example.com/hook",
                    enabled: true,
                    kind: "webhook",
                    organizationId: "org",
                    secretCiphertext: sealed.ciphertext,
                    secretIv: sealed.iv,
                },
            ],
            notificationDeliveries: [pending("d1", "ch1", 1, { _id: "d1", kind: "webhook" })],
        });
        const fetchSpy = vi.fn<typeof globalThis.fetch>();

        await runNotificationSweep(database, { fetch: fetchSpy, now: NOW });

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(database.rows.notificationDeliveries[0]).toMatchObject({ error: expect.stringContaining("encryption key") as unknown, status: "failed" });
    });

    it("prunes finished rows past the retention window and keeps recent ones", async () => {
        const database = fakeDatabase({
            notificationChannels: [],
            notificationDeliveries: [
                pending("old_delivered", "ch", 1, { _id: "old_delivered", status: "delivered", updatedAt: NOW - RETENTION_MS - 1 }),
                pending("old_failed", "ch", 1, { _id: "old_failed", status: "failed", updatedAt: NOW - RETENTION_MS - 1 }),
                pending("recent_failed", "ch", 1, { _id: "recent_failed", status: "failed", updatedAt: NOW - 1000 }),
            ],
        });

        const result = await runNotificationSweep(database, { fetch: vi.fn<typeof globalThis.fetch>(), now: NOW });

        expect(result.pruned).toBe(2);
        expect(database.rows.notificationDeliveries.map((row) => row._id)).toStrictEqual(["recent_failed"]);
    });
});
