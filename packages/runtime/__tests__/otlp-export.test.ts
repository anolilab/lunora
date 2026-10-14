import { afterEach, describe, expect, it, vi } from "vitest";

import { OTLP_GZIP_THRESHOLD, otlpSend } from "../src/otlp-export";

/** Pull the request headers off a recorded `fetch` call. */
const headersOf = (init: RequestInit): Record<string, string> => (init.headers ?? {}) as Record<string, string>;

describe("otlpSend rejection reporting", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    // There is no retry: a rejected batch is gone. Without a line in the log, a
    // wrong token (401) or a wrong path (404) is indistinguishable from a working
    // pipeline on every isolate forever — every post "succeeds" and telemetry
    // simply never arrives.
    it("reports a non-OK collector response with its status and host, and never its body", async () => {
        expect.assertions(4);

        vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(async () => new Response("token 'sk-live-abc' is not valid", { status: 401 })),
        );

        const errors = vi.spyOn(console, "error").mockImplementation(() => {});

        await otlpSend("https://collector.example/v1/traces?key=super-secret", {}, {});

        expect(errors).toHaveBeenCalledTimes(1);

        const line = String(errors.mock.calls[0]![0]);

        expect(line).toContain("collector.example");
        expect(line).toContain("401");
        // Neither the response body nor the URL's query may echo into the log.
        expect(line).not.toContain("sk-live-abc");
    });

    it("stays silent on a transport error — transient and self-healing, unlike a rejection", async () => {
        expect.assertions(1);

        vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(async () => {
                throw new Error("network down");
            }),
        );

        const errors = vi.spyOn(console, "error").mockImplementation(() => {});

        await otlpSend("https://collector.example/v1/traces", {}, {});

        expect(errors).not.toHaveBeenCalled();
    });
});

describe("otlpSend gzip threshold", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("gzips a body that clears the threshold in UTF-8 bytes even when its UTF-16 length does not", async () => {
        expect.assertions(4);

        // "€" is ONE UTF-16 code unit but THREE UTF-8 bytes — the multibyte case
        // common in `error.message`. This body sits UNDER the threshold by `.length`
        // (the old heuristic) but well OVER it by byte length (the fix).
        const message = "€".repeat(OTLP_GZIP_THRESHOLD - 200);
        const body = { message };
        const json = JSON.stringify(body);

        // Precondition: the old `json.length` check would have SKIPPED gzip…
        expect(json.length).toBeLessThan(OTLP_GZIP_THRESHOLD);
        // …while the actual byte length clearly warrants it.
        expect(new TextEncoder().encode(json).byteLength).toBeGreaterThanOrEqual(OTLP_GZIP_THRESHOLD);

        const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
        vi.stubGlobal("fetch", fetchMock);

        await otlpSend("https://collector.example/v1/logs", body, { "content-type": "application/json" });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(headersOf((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1])["content-encoding"]).toBe("gzip");
    });

    it("does not gzip a small ASCII body", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok"));
        vi.stubGlobal("fetch", fetchMock);

        await otlpSend("https://collector.example/v1/logs", { message: "hi" }, { "content-type": "application/json" });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(headersOf((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1])["content-encoding"]).toBeUndefined();
    });
});
