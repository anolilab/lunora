import { describe, expect, it, vi } from "vitest";

import { createQueueCaptureSink, shouldCaptureQueue } from "../src/capture";
import type { CapturedQueueMessage } from "../src/dispatch";

/** One minimal captured record for the sink payload assertions. */
const record = (overrides: Partial<CapturedQueueMessage> = {}): CapturedQueueMessage => {
    return {
        attempts: 1,
        body: { ok: true },
        deadLettered: false,
        exportName: "myQueue",
        messageId: "cf-msg-1",
        outcome: "ack",
        queue: "my-queue",
        timestamp: 0,
        ...overrides,
    };
};

/** A `SHARD` namespace double capturing the stub's `fetch` calls. */
const namespace = () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(new Response(null, { status: 200 })));
    const stub = { fetch };
    const idFromName = vi.fn<(name: string) => string>((name) => `id:${name}`);
    const get = vi.fn<(id: unknown) => typeof stub>(() => stub);

    return { fetch, get, idFromName, stub };
};

describe("shouldCaptureQueue", () => {
    it("honours the explicit LUNORA_QUEUE_CAPTURE flag over the environment", () => {
        expect.assertions(4);

        expect(shouldCaptureQueue({ LUNORA_QUEUE_CAPTURE: "1", WORKER_ENV: "production" })).toBe(true);
        expect(shouldCaptureQueue({ LUNORA_QUEUE_CAPTURE: "true", WORKER_ENV: "production" })).toBe(true);
        expect(shouldCaptureQueue({ LUNORA_QUEUE_CAPTURE: "0", WORKER_ENV: "development" })).toBe(false);
        expect(shouldCaptureQueue({ LUNORA_QUEUE_CAPTURE: "false", WORKER_ENV: "development" })).toBe(false);
    });

    it("defaults to on in a development environment and off otherwise", () => {
        expect.assertions(3);

        expect(shouldCaptureQueue({ WORKER_ENV: "development" })).toBe(true);
        expect(shouldCaptureQueue({ NODE_ENV: "test" })).toBe(true);
        expect(shouldCaptureQueue({ WORKER_ENV: "production" })).toBe(false);
    });
});

describe("createQueueCaptureSink", () => {
    it("no-ops without a SHARD binding or an admin token", async () => {
        expect.assertions(2);

        const ns = namespace();

        await createQueueCaptureSink({})([record()]);
        // Binding present but no token:
        await createQueueCaptureSink({ SHARD: { get: ns.get, idFromName: ns.idFromName } })([record()]);

        expect(ns.get).not.toHaveBeenCalled();
        expect(ns.fetch).not.toHaveBeenCalled();
    });

    it("no-ops on an empty batch", async () => {
        expect.assertions(1);

        const ns = namespace();

        await createQueueCaptureSink({ LUNORA_ADMIN_TOKEN: "tok", SHARD: { get: ns.get, idFromName: ns.idFromName } })([]);

        expect(ns.fetch).not.toHaveBeenCalled();
    });

    it("pOSTs the batch to the root shard's recordQueueMessage admin RPC", async () => {
        expect.assertions(5);

        const ns = namespace();
        const messages = [record(), record({ messageId: "cf-msg-2", outcome: "retry" })];

        await createQueueCaptureSink({ LUNORA_ADMIN_TOKEN: "tok", SHARD: { get: ns.get, idFromName: ns.idFromName } })(messages);

        expect(ns.idFromName).toHaveBeenCalledWith("__root__");
        expect(ns.fetch).toHaveBeenCalledTimes(1);

        const [url, init] = ns.fetch.mock.calls[0] as [string, RequestInit];

        expect(url).toBe("https://shard.internal/rpc");
        expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
        expect(JSON.parse(init.body as string)).toStrictEqual({ args: { messages }, functionPath: "__lunora_admin__:recordQueueMessage" });
    });

    it("routes through a jurisdiction-scoped namespace when configured", async () => {
        expect.assertions(2);

        const inner = namespace();
        const jurisdiction = vi.fn(() => {
            return { get: inner.get, idFromName: inner.idFromName };
        });
        const outer = namespace();

        await createQueueCaptureSink(
            { LUNORA_ADMIN_TOKEN: "tok", SHARD: { get: outer.get, idFromName: outer.idFromName, jurisdiction } },
            { jurisdiction: "eu" },
        )([record()]);

        expect(jurisdiction).toHaveBeenCalledWith("eu");
        expect(inner.fetch).toHaveBeenCalledTimes(1);
    });

    it("fails closed when a jurisdiction is configured but the namespace can't scope to it", async () => {
        expect.assertions(2);

        const ns = namespace();

        // No `jurisdiction` method on the namespace, but the option asks for one:
        // recording into the un-pinned namespace would leak bodies outside the
        // residency boundary, so the sink throws rather than silently writing.
        await expect(
            createQueueCaptureSink({ LUNORA_ADMIN_TOKEN: "tok", SHARD: { get: ns.get, idFromName: ns.idFromName } }, { jurisdiction: "eu" })([record()]),
        ).rejects.toThrow(/does not support jurisdiction/u);

        expect(ns.fetch).not.toHaveBeenCalled();
    });
});
