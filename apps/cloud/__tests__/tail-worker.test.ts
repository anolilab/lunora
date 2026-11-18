import { afterEach, describe, expect, it, vi } from "vitest";

import tailWorker from "../src/tail/worker";

/**
 * The tail worker's send to `POST /v1/logs/tail`: a tail invocation cannot be
 * replayed, so a refused flush is retried once when the route stored nothing,
 * and any loss is written to the tail worker's own logs instead of vanishing.
 */

const environment = { LUNORA_CONTROL_PLANE_URL: "https://cloud.test/", LUNORA_TAIL_SECRET: "tail-secret" };
const events = [{ logs: [{ message: [JSON.stringify({ level: "info", message: "hi", source: "lunora", ts: 1, type: "log" })] }], scriptName: "app-v1" }];

/** Run one tail invocation and wait for the send it handed to `waitUntil`. */
const flush = async (): Promise<void> => {
    const pending: Promise<unknown>[] = [];

    await tailWorker.tail(events, environment, { waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);
};

describe("the tail worker's flush", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("retries once on a 5xx and logs nothing when the retry is stored", async () => {
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
            .mockResolvedValueOnce(Response.json({ failed: 0, ingested: 1, scripts: 1 }));
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        vi.stubGlobal("fetch", fetchMock);
        await flush();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://cloud.test/v1/logs/tail");
        expect(error).not.toHaveBeenCalled();
    });

    it("logs a flush still refused after its retry", async () => {
        const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection reset"));
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        vi.stubGlobal("fetch", fetchMock);
        await flush();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(error).toHaveBeenCalledWith("[tail]", expect.stringContaining("connection reset"));
    });

    it("does not retry a 403, and logs it", async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("invalid tail secret", { status: 403 }));
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        vi.stubGlobal("fetch", fetchMock);
        await flush();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith("[tail]", expect.stringContaining("HTTP 403"));
    });

    it("logs the batches a 200 counted as failed, without resending the ones it stored", async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ failed: 1, ingested: 0, scripts: 1 }));
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        vi.stubGlobal("fetch", fetchMock);
        await flush();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith("[tail]", "1 of 1 log batches were refused by the ingest");
    });
});
