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

    it("holds checkpoint listeners with the values, so one never reads a sibling the batch has not applied", async () => {
        expect.assertions(1);

        const { sockets, WebSocket } = createSocketHarness();
        const client = new LunoraClient({ heartbeatIntervalMs: 0, url: "http://app.test", WebSocket });
        const seen: unknown[] = [];

        client.subscribe(fnRef("todos.count"), {}, () => undefined, {
            onCheckpoint: () => seen.push(client.peekActiveQuerySnapshot("todos.list", {}).value),
        });
        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();
        sockets[0]?.open();
        await settle();

        const [countId, listId] = (sockets[0]?.frames() ?? []).filter((frame) => frame.type === "subscribe").map((frame) => frame.id);

        sockets[0]?.receive({ type: "batchStart" });
        sockets[0]?.receive({ cursor: 1, data: 1, id: countId, lastMutationId: 1, type: "data" });
        sockets[0]?.receive({ cursor: 1, data: "a", id: listId, type: "data" });
        sockets[0]?.receive({ type: "batchEnd" });

        expect(seen).toStrictEqual(["a"]);

        client.close();
    });

    it("stops applying a batch once a listener retires its socket", async () => {
        expect.assertions(1);

        const { sockets, WebSocket } = createSocketHarness();
        const client = new LunoraClient({ authTokenOnUpgrade: true, heartbeatIntervalMs: 0, url: "http://app.test", WebSocket });
        const lists: unknown[] = [];

        client.setAuthToken("token-1", "user-1");
        // A refusal the app answers by switching account: the rest of the batch is the old account's.
        client.subscribe(fnRef("todos.count"), {}, () => undefined, {
            onError: () => {
                client.setAuthToken("token-2", "user-2");
            },
        });
        client.subscribe(fnRef("todos.list"), {}, (value) => lists.push(value));
        await settle();
        sockets[0]?.open();
        await settle();

        const [countId, listId] = (sockets[0]?.frames() ?? []).filter((frame) => frame.type === "subscribe").map((frame) => frame.id);

        sockets[0]?.receive({ type: "batchStart" });
        sockets[0]?.receive({ error: { code: "FORBIDDEN", message: "no" }, id: countId, type: "error" });
        sockets[0]?.receive({ data: "old account's rows", id: listId, type: "data" });
        sockets[0]?.receive({ type: "batchEnd" });

        expect(lists).not.toContain("old account's rows");

        client.close();
    });

    it("notifies no further subscription once a listener closes the client", async () => {
        expect.assertions(1);

        const { client, ids, observed, socket } = await twoSubscriptions();

        client.subscribe(fnRef("todos.count"), {}, () => {
            client.close();
        });

        socket?.receive({ type: "batchStart" });
        socket?.receive({ data: 1, id: ids[0], type: "data" });
        socket?.receive({ data: "a", id: ids[1], type: "data" });
        socket?.receive({ type: "batchEnd" });

        expect(observed.filter((entry) => entry.startsWith("list:"))).toStrictEqual([]);
    });

    it("gives a listener subscribed during the notifications the batch's value once", async () => {
        expect.assertions(1);

        const { client, ids, socket } = await twoSubscriptions();
        const late: unknown[] = [];
        let subscribed = false;

        client.subscribe(fnRef("todos.count"), {}, () => {
            if (!subscribed) {
                subscribed = true;
                client.subscribe(fnRef("todos.list"), {}, (value) => late.push(value));
            }
        });

        socket?.receive({ type: "batchStart" });
        socket?.receive({ data: 1, id: ids[0], type: "data" });
        socket?.receive({ data: "a", id: ids[1], type: "data" });
        socket?.receive({ type: "batchEnd" });

        expect(late).toStrictEqual(["a"]);

        client.close();
    });
});
