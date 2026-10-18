import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_BATCH_ENTRIES } from "../../../shared/batch-wire";
import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

describe("batched replay order", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("does not send a later chunk past a write the earlier chunk had to retry", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const applied: string[] = [];
        let failedOnce = false;
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            const body = JSON.parse(init?.body as string) as { args?: { text: string }; calls?: { args: { text: string } }[] };

            // A lone retried write rides the single-call path.
            if (!body.calls) {
                applied.push(body.args?.text ?? "");

                return jsonResponse({ result: { ok: true } });
            }

            return jsonResponse({
                results: body.calls.map((call, id) => {
                    if (call.args.text === "w0" && !failedOnce) {
                        failedOnce = true;

                        return { body: { error: { code: "SHARD_ERROR", message: "shard hiccup" } }, id };
                    }

                    applied.push(call.args.text);

                    return { body: { result: { ok: true } }, id };
                }),
            });
        });
        const { sockets, WebSocket } = createSocketHarness();
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            offlineQueue: { maxItems: MAX_BATCH_ENTRIES + 10, queueBeforeFirstConnect: true, replayRetry: { baseDelayMs: 10, maxDelayMs: 20 } },
            persistence: createInMemoryPersistence(),
            url: "http://app.test",
            WebSocket,
        });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        const last = `w${(MAX_BATCH_ENTRIES + 1).toString()}`;
        const writes = Array.from({ length: MAX_BATCH_ENTRIES + 2 }, (_, index) => client.mutation(fnRef("todos.set"), { text: `w${index.toString()}` }));

        await settle();
        sockets[0]?.open();
        await vi.advanceTimersByTimeAsync(2000);
        await Promise.all(writes);

        expect(applied).toContain("w0");
        expect(applied).toContain(last);
        expect(applied.indexOf("w0")).toBeLessThan(applied.indexOf(last));

        client.close();
    });
});
