import { afterEach, describe, expect, it, vi } from "vitest";

import { OTLP_GZIP_THRESHOLD, otlpSend } from "../src/otlp-export";

/** Pull the request headers off a recorded `fetch` call. */
const headersOf = (init: RequestInit): Record<string, string> => (init.headers ?? {}) as Record<string, string>;

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
