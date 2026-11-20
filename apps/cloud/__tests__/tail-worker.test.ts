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

    it("splits a flush past the route's body cap into bodies under 8 MiB, each sent on its own", async () => {
        // Six scripts of about 3 MiB each: one 18 MiB body would be refused whole.
        const message = "x".repeat(64 * 1024);
        const line = JSON.stringify({ level: "info", message, source: "lunora", ts: 1, type: "log" });
        const big = ["a", "b", "c", "d", "e", "f"].map((script) => {
            return {
                logs: Array.from({ length: 48 }, () => {
                    return { message: [line] };
                }),
                scriptName: `${script}-v1`,
            };
        });
        const bodies: string[] = [];
        const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
            bodies.push(typeof init?.body === "string" ? init.body : "");

            return bodies.length === 1 ? Response.json({ failed: 0, ingested: 2, scripts: 2 }) : new Response("invalid tail secret", { status: 403 });
        });
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const pending: Promise<unknown>[] = [];

        vi.stubGlobal("fetch", fetchMock);
        await tailWorker.tail(big, environment, { waitUntil: (promise) => pending.push(promise) });
        await Promise.all(pending);

        expect(bodies).toHaveLength(3);

        const sent = bodies.flatMap((body) => {
            expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);

            return (JSON.parse(body) as { batches: { scriptName: string }[] }).batches.map((batch) => batch.scriptName);
        });

        expect(sent).toStrictEqual(["a-v1", "b-v1", "c-v1", "d-v1", "e-v1", "f-v1"]);
        // The stored body is not reported; each refused one is, with its own batch count.
        expect(error.mock.calls).toStrictEqual([
            ["[tail]", "log lines of 2 batches not stored: HTTP 403"],
            ["[tail]", "log lines of 2 batches not stored: HTTP 403"],
        ]);
    });
});
