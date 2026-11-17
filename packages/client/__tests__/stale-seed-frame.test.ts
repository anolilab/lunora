import { afterEach, describe, expect, it, vi } from "vitest";

import { RESUBSCRIBE_ACK_TIMEOUT_MS } from "../src/client-tuning";
import { LunoraClient } from "../src/lunora-client";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

/** A subscription whose first `subscribe` frame went unanswered, so the watchdog re-sent it and two seeds are in flight. */
const resentSubscription = async () => {
    const { sockets, WebSocket } = createSocketHarness();
    const client = new LunoraClient({
        fetch: vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } })),
        heartbeatIntervalMs: 0,
        reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
        url: "http://app.test",
        WebSocket,
    });
    const values: unknown[] = [];

    client.subscribe(fnRef("todos.list"), {}, (value) => values.push(value));
    await settle();
    sockets[0]?.open();
    await settle();
    await vi.advanceTimersByTimeAsync(RESUBSCRIBE_ACK_TIMEOUT_MS);

    const id = sockets[0]?.frames().find((frame) => frame.type === "subscribe")?.id;

    return { client, id, sockets, values };
};

describe("two seeds of one re-sent subscribe", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("keeps the newer value and cursor when the older seed arrives last", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        const { client, id, sockets, values } = await resentSubscription();

        expect(sockets[0]?.frames().filter((frame) => frame.type === "subscribe")).toHaveLength(2);

        sockets[0]?.receive({ cursor: 10, data: "new", epoch: "e1", id, type: "data" });
        sockets[0]?.receive({ cursor: 5, data: "old", epoch: "e1", id, type: "data" });

        expect(values.at(-1)).toBe("new");

        // The resume cursor a reconnect sends is the newer one.
        sockets[0]?.triggerClose();
        await vi.advanceTimersByTimeAsync(10);
        sockets[1]?.open();
        await settle();

        const resumed = sockets[1]?.frames().find((frame) => frame.type === "subscribe") as { query?: { sinceSeq?: number } } | undefined;

        expect(resumed?.query?.sinceSeq).toBe(10);
        expect(values).toStrictEqual(["new"]);

        client.close();
    });

    it("still applies a frame of a new epoch, whatever its cursor", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const { client, id, sockets, values } = await resentSubscription();

        sockets[0]?.receive({ cursor: 10, data: "before", epoch: "e1", id, type: "data" });
        sockets[0]?.receive({ cursor: 3, data: "after", epoch: "e2", id, type: "data" });

        expect(values.at(-1)).toBe("after");

        // A frame with no cursor carries no order to compare, so it applies too.
        sockets[0]?.receive({ data: "uncursored", id, type: "data" });

        expect(values.at(-1)).toBe("uncursored");

        client.close();
    });
});
