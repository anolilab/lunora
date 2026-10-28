import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

const twoSubscriptions = async () => {
    const { sockets, WebSocket } = createSocketHarness();
    const client = new LunoraClient({
        fetch: vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } })),
        heartbeatIntervalMs: 0,
        url: "http://app.test",
        WebSocket,
    });
    // What each listener saw of BOTH queries at the moment it ran.
    const observed: string[] = [];
    const read = (): string =>
        `${String(client.peekActiveQuerySnapshot("todos.count", {}).value)}/${String(client.peekActiveQuerySnapshot("todos.list", {}).value)}`;

    client.subscribe(fnRef("todos.count"), {}, () => observed.push(`count:${read()}`));
    client.subscribe(fnRef("todos.list"), {}, () => observed.push(`list:${read()}`));
    await settle();
    sockets[0]?.open();
    await settle();

    const ids = (sockets[0]?.frames() ?? []).filter((frame) => frame.type === "subscribe").map((frame) => frame.id);

    return { client, ids, observed, socket: sockets[0] };
};

describe("refresh batch", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("announces refreshBatch on connect", async () => {
        expect.assertions(1);

        const { client, socket } = await twoSubscriptions();

        const connect = socket?.sent.map((frame) => JSON.parse(frame) as { caps?: string[]; type: string }).find((frame) => frame.type === "connect");

        expect(connect?.caps).toContain("refreshBatch");

        client.close();
    });

    it("applies a bracketed batch together and notifies each subscription once, after both changed", async () => {
        expect.assertions(2);

        const { client, ids, observed, socket } = await twoSubscriptions();
        const [countId, listId] = ids;

        socket?.receive({ type: "batchStart" });
        socket?.receive({ data: 1, id: countId, type: "data" });
        socket?.receive({ data: "a", id: listId, type: "data" });

        // Held until the bracket closes: nothing has been applied or notified yet.
        expect(observed).toStrictEqual([]);

        socket?.receive({ type: "batchEnd" });

        expect(observed).toStrictEqual(["count:1/a", "list:1/a"]);

        client.close();
    });

    it("drops a bracket its socket closed in the middle of", async () => {
        expect.assertions(1);

        const { client, ids, observed, socket } = await twoSubscriptions();

        socket?.receive({ type: "batchStart" });
        socket?.receive({ data: 1, id: ids[0], type: "data" });
        socket?.triggerClose();
        await settle();

        expect(observed).toStrictEqual([]);

        client.close();
    });

    it("applies frames outside a bracket as they land", async () => {
        expect.assertions(1);

        const { client, ids, observed, socket } = await twoSubscriptions();

        socket?.receive({ data: 1, id: ids[0], type: "data" });
        socket?.receive({ data: "a", id: ids[1], type: "data" });

        expect(observed).toStrictEqual(["count:1/undefined", "list:1/a"]);

        client.close();
    });
});
