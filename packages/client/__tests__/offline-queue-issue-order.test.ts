import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import type { QueuedMutation } from "../src/offline-queue";
import { OfflineQueue } from "../src/offline-queue";
import { createInMemoryPersistence } from "../src/persistence";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

const entry = (id: string, issueSeq?: number): QueuedMutation => {
    return {
        args: {},
        functionPath: "todos.set",
        id,
        issueSeq,
        reject: () => undefined,
        resolve: () => undefined,
    };
};

const idsOf = (queue: OfflineQueue): (string | undefined)[] => queue.drain().map((item) => item.id);

describe("queued writes keep their issue order", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("replays a write whose direct send failed ambiguously before one queued while it was in flight", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const sent: { id: string | undefined; text: string }[] = [];
        let failDirectSend: (() => void) | undefined;
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            const body = JSON.parse(init?.body as string) as { args?: { text: string }; calls?: { args: { text: string }; mutationId?: string }[] };
            const id = (init?.headers as Record<string, string>)["x-lunora-mutation-id"];

            if (sent.length === 0 && failDirectSend === undefined) {
                // The direct send of write A: it hangs until the test drops it.
                sent.push({ id, text: body.args?.text ?? "" });

                return new Promise<Response>((_resolve, reject) => {
                    failDirectSend = () => {
                        reject(new TypeError("network connection lost"));
                    };
                });
            }

            if (body.calls) {
                for (const call of body.calls) {
                    sent.push({ id: call.mutationId, text: call.args.text });
                }

                return jsonResponse({
                    results: body.calls.map((_call, index) => {
                        return { body: { result: { ok: true } }, id: index };
                    }),
                });
            }

            sent.push({ id, text: body.args?.text ?? "" });

            return jsonResponse({ result: { ok: true } });
        });
        const { sockets, WebSocket } = createSocketHarness();
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            persistence: createInMemoryPersistence(),
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "http://app.test",
            WebSocket,
        });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        await settle();

        const writeA = client.mutation(fnRef("todos.set"), { text: "A" });

        await settle();
        // The connection drops while A is still on the wire, so B is queued ahead of A's verdict.
        sockets[0]?.triggerClose();

        const writeB = client.mutation(fnRef("todos.set"), { text: "B" });

        await settle();
        failDirectSend?.();
        await settle();
        await vi.advanceTimersByTimeAsync(10);
        sockets.at(-1)?.open();
        await vi.runAllTimersAsync();

        await expect(Promise.all([writeA, writeB])).resolves.toHaveLength(2);
        expect(sent.map((call) => call.text)).toStrictEqual(["A", "A", "B"]);
        // Both replays carry A's own idempotency key, not one shared with B.
        expect(new Set(sent.map((call) => call.id)).size).toBe(2);

        client.close();
    });

    it("keeps plain FIFO for ordinary offline writes", () => {
        expect.assertions(1);

        const queue = new OfflineQueue();

        queue.enqueue(entry("a", 1));
        queue.enqueue(entry("b", 2));
        queue.enqueue(entry("c", 3));

        expect(idsOf(queue)).toStrictEqual(["a", "b", "c"]);
    });

    it("inserts a late-queued older write before newer ones, but after hydrated records", async () => {
        expect.assertions(2);

        const persistence = createInMemoryPersistence();

        await persistence.append({ args: {}, functionPath: "todos.set", id: "restored" });

        const queue = new OfflineQueue({}, { persistence });

        queue.enqueue(entry("b", 2));
        queue.enqueue(entry("d", 4));
        queue.enqueue(entry("c", 3));
        queue.enqueue(entry("a", 1));
        await queue.hydrate();

        expect(idsOf(queue)).toStrictEqual(["restored", "a", "b", "c", "d"]);

        queue.enqueue(entry("e", 5));
        queue.enqueue(entry("unnumbered"));
        queue.enqueue(entry("f", 6));

        expect(idsOf(queue)).toStrictEqual(["e", "unnumbered", "f"]);
    });
});
