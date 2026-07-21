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

    it("passes an abort signal on the capture fetch", async () => {
        expect.assertions(2);

        const ns = namespace();

        await createQueueCaptureSink({ LUNORA_ADMIN_TOKEN: "tok", SHARD: { get: ns.get, idFromName: ns.idFromName } })([record()]);

        const [, init] = ns.fetch.mock.calls[0] as [string, RequestInit];

        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.signal?.aborted).toBe(false);
    });

    it("aborts the capture fetch when the root shard never responds", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        try {
            // A stub whose fetch hangs until its abort signal fires — stands in for an
            // unresponsive root shard DO. Without the sink's timeout this would stall
            // the whole queue() invocation.
            const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
                (_url, init) =>
                    new Promise((_resolve, reject) => {
                        init?.signal?.addEventListener("abort", () => {
                            reject(new DOMException("Aborted", "AbortError"));
                        });
                    }),
            );
            const idFromName = vi.fn<(name: string) => string>((name) => `id:${name}`);
            const get = vi.fn<(id: unknown) => { fetch: typeof fetch }>(() => {
                return { fetch };
            });

            const pending = createQueueCaptureSink({ LUNORA_ADMIN_TOKEN: "tok", SHARD: { get, idFromName } })([record()]);

            // Advance past the 5s cap and assert the hung fetch is aborted. The
            // expectation subscribes to `pending` before the timer fires, so the
            // rejection is always observed (no unhandled rejection).
            await Promise.all([expect(pending).rejects.toThrow(/abort/iu), vi.advanceTimersByTimeAsync(5000)]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("throws a diagnostic when the root shard rejects the capture write (non-2xx)", async () => {
        expect.assertions(2);

        const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
            Promise.resolve(new Response("unauthorized", { status: 401, statusText: "Unauthorized" })),
        );
        const idFromName = vi.fn<(name: string) => string>((name) => `id:${name}`);
        const get = vi.fn<(id: unknown) => { fetch: typeof fetch }>(() => {
            return { fetch };
        });

        // A 401 from a stale/rotated LUNORA_ADMIN_TOKEN (or a shard-side 500) used to
        // be indistinguishable from success — the response was never inspected. It must
        // now surface so `dispatchQueueBatch` can log it; the sink reads the body first
        // so it's consumed (unread bodies warn in workerd) and feeds the diagnostic.
        await expect(createQueueCaptureSink({ LUNORA_ADMIN_TOKEN: "tok", SHARD: { get, idFromName } })([record()])).rejects.toThrow(
            /capture write to the root shard failed \(401/u,
        );

        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("routes through a jurisdiction-scoped namespace when configured", async () => {
        expect.assertions(2);

        const inner = namespace();
        const jurisdiction = vi.fn<(jurisdiction: string) => { get: typeof inner.get; idFromName: typeof inner.idFromName }>(() => {
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
