import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ObservabilityEvent } from "../src/observability.js";
import { combineSinks, consoleSink, sentrySink, webhookSink } from "../src/observability-sinks.js";

const okEvent: ObservabilityEvent = { durationMs: 5, functionPath: "messages:list", ok: true, shardKey: "channel-1" };
const errorEvent: ObservabilityEvent = {
    durationMs: 9,
    error: { code: "CONFLICT", message: "boom: user@example.com", status: 409 },
    functionPath: "messages:send",
    ok: false,
    shardKey: "channel-1",
};

describe("observability-sinks", () => {
    describe("consoleSink", () => {
        let log: ReturnType<typeof vi.spyOn>;
        let error: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
            log = vi.spyOn(console, "log").mockImplementation(() => undefined);
            error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("logs ok events via console.log and error events via console.error", () => {
            expect.assertions(2);

            const sink = consoleSink();

            sink.onRpc!(okEvent);
            sink.onRpc!(errorEvent);

            expect(log).toHaveBeenCalledWith("[cirrus:rpc]", okEvent);
            expect(error).toHaveBeenCalledWith("[cirrus:rpc]", errorEvent);
        });

        it("filters out ok events when onlyErrors is set", () => {
            expect.assertions(2);

            const sink = consoleSink({ onlyErrors: true });

            sink.onRpc!(okEvent);
            sink.onRpc!(errorEvent);

            expect(log).not.toHaveBeenCalled();
            expect(error).toHaveBeenCalledTimes(1);
        });
    });

    describe("webhookSink", () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("pOSTs the serialized event with merged headers", () => {
            expect.assertions(4);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));
            vi.stubGlobal("fetch", fetchMock);

            const sink = webhookSink({ headers: { authorization: "Bearer secret" }, url: "https://ingest.example/events" });

            sink.onRpc!(okEvent);

            expect(fetchMock).toHaveBeenCalledTimes(1);

            const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(url).toBe("https://ingest.example/events");
            expect(init).toMatchObject({
                headers: { authorization: "Bearer secret", "content-type": "application/json" },
                method: "POST",
            });
            expect(init.body).toBe(JSON.stringify(okEvent));

            vi.unstubAllGlobals();
        });

        it("swallows a rejected fetch", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => {
                throw new Error("network down");
            });
            vi.stubGlobal("fetch", fetchMock);

            const sink = webhookSink({ url: "https://ingest.example/events" });

            expect(() => {
                sink.onRpc!(okEvent);
            }).not.toThrow();

            // Let the rejected promise settle without an unhandled rejection.
            await Promise.resolve();

            vi.unstubAllGlobals();
        });

        it("swallows a synchronous fetch throw", () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(() => {
                throw new Error("invalid url");
            });
            vi.stubGlobal("fetch", fetchMock);

            const sink = webhookSink({ url: "not-a-url" });

            expect(() => {
                sink.onRpc!(okEvent);
            }).not.toThrow();

            vi.unstubAllGlobals();
        });

        it("skips ok events when onlyErrors is set", () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
            vi.stubGlobal("fetch", fetchMock);

            const sink = webhookSink({ onlyErrors: true, url: "https://ingest.example/events" });

            sink.onRpc!(okEvent);

            expect(fetchMock).not.toHaveBeenCalled();

            sink.onRpc!(errorEvent);

            expect(fetchMock).toHaveBeenCalledTimes(1);

            vi.unstubAllGlobals();
        });
    });

    describe("sentrySink", () => {
        it("captures only error events by default", () => {
            expect.assertions(2);

            const capture = vi.fn<(event: ObservabilityEvent) => void>();
            const sink = sentrySink({ capture });

            sink.onRpc!(okEvent);

            expect(capture).not.toHaveBeenCalled();

            sink.onRpc!(errorEvent);

            expect(capture).toHaveBeenCalledWith(errorEvent);
        });

        it("captures all events when onlyErrors is false", () => {
            expect.assertions(1);

            const capture = vi.fn<(event: ObservabilityEvent) => void>();
            const sink = sentrySink({ capture, onlyErrors: false });

            sink.onRpc!(okEvent);
            sink.onRpc!(errorEvent);

            expect(capture).toHaveBeenCalledTimes(2);
        });

        it("swallows a throwing capture callback", () => {
            expect.assertions(1);

            const sink = sentrySink({
                capture: () => {
                    throw new Error("sentry down");
                },
            });

            expect(() => {
                sink.onRpc!(errorEvent);
            }).not.toThrow();
        });
    });

    describe("combineSinks", () => {
        it("fans out to every child sink", () => {
            expect.assertions(2);

            const a = vi.fn<(event: ObservabilityEvent) => void>();
            const b = vi.fn<(event: ObservabilityEvent) => void>();
            const sink = combineSinks({ onRpc: a }, { onRpc: b });

            sink.onRpc!(okEvent);

            expect(a).toHaveBeenCalledWith(okEvent);
            expect(b).toHaveBeenCalledWith(okEvent);
        });

        it("isolates a throwing child so the rest still run", () => {
            expect.assertions(1);

            const b = vi.fn<(event: ObservabilityEvent) => void>();
            const sink = combineSinks(
                {
                    onRpc: () => {
                        throw new Error("bad sink");
                    },
                },
                { onRpc: b },
            );

            sink.onRpc!(okEvent);

            expect(b).toHaveBeenCalledWith(okEvent);
        });
    });
});
