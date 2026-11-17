import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

describe("batched replay of a body that is not an envelope", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("re-queues the drained writes when the batch response body is JSON null", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const applied: string[] = [];
        let calls = 0;
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            const body = JSON.parse(init?.body as string) as { args?: { text: string }; calls?: { args: { text: string } }[] };

            calls += 1;

            if (calls === 1) {
                return jsonResponse(null);
            }

            if (!body.calls) {
                applied.push(body.args?.text ?? "");

                return jsonResponse({ result: { ok: true } });
            }

            return jsonResponse({
                results: body.calls.map((call, id) => {
                    applied.push(call.args.text);

                    return { body: { result: { ok: true } }, id };
                }),
            });
        });
        const { sockets, WebSocket } = createSocketHarness();
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence: createInMemoryPersistence(),
            url: "http://app.test",
            WebSocket,
        });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);

        const writes = [client.mutation(fnRef("todos.set"), { text: "w0" }), client.mutation(fnRef("todos.set"), { text: "w1" })];

        await settle();
        sockets[0]?.open();
        await vi.advanceTimersByTimeAsync(120_000);
        await Promise.all(writes);

        expect(applied.toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["w0", "w1"]);
        expect(calls).toBeGreaterThan(1);
    });
});
