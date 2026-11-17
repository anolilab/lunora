import { bench, describe } from "vitest";

import { createSocketHarness, fnRef, jsonResponse } from "../__tests__/lib/harness";
import { LunoraClient } from "../src/lunora-client";

/**
 * The live-query path end to end, as a browser sees it: a raw WebSocket frame
 * string goes in, subscriber callbacks come out. Covers JSON parse, wire decode,
 * the delta merge, the optimistic re-fold and the fan-out.
 */

const ROWS = 1000;

const row = (index: number, version = 0): Record<string, unknown> => {
    return { _creationTime: index, _id: `row_${index.toString().padStart(6, "0")}`, done: index % 2 === 0, text: `todo ${index.toString()}`, version };
};

const rows = Array.from({ length: ROWS }, (_v, index) => row(index));

interface Fixture {
    client: LunoraClient;
    receive: (frame: string) => void;
    subscriptionId: string;
}

const LIST = fnRef("todos:list");

const setup = (listeners: number, fetchImpl: typeof fetch = async () => jsonResponse({ result: null })): Fixture => {
    const { sockets, WebSocket } = createSocketHarness();
    const client = new LunoraClient({ fetch: fetchImpl, heartbeatIntervalMs: 0, url: "http://app.test", WebSocket });

    for (let index = 0; index < listeners; index += 1) {
        client.subscribe(LIST, {}, () => undefined);
    }

    const socket = sockets[0]!;

    socket.open();

    const subscriptionId = socket.frames().find((frame) => frame.type === "subscribe")!.id!;

    socket.receive({ id: subscriptionId, type: "ack" });
    socket.receive({ cursor: 1, data: rows, epoch: "e", id: subscriptionId, type: "data" });

    return {
        client,
        receive: (frame) => {
            socket.receive(frame);
        },
        subscriptionId,
    };
};

const updateFrames = (fixture: Fixture): (() => string) => {
    let cursor = 1;

    return () => {
        cursor += 1;

        const index = cursor % ROWS;

        return JSON.stringify({
            cursor,
            delta: { key: `row_${index.toString().padStart(6, "0")}`, op: "update", row: row(index, cursor), table: "todos" },
            epoch: "e",
            id: fixture.subscriptionId,
            type: "delta",
        });
    };
};

describe("live query: 1,000-row result", () => {
    const single = setup(1);
    const nextUpdate = updateFrames(single);

    bench("row update delta, 1 subscriber", () => {
        single.receive(nextUpdate());
    });

    const many = setup(100);
    const nextManyUpdate = updateFrames(many);

    bench("row update delta, 100 subscribers on the same query", () => {
        many.receive(nextManyUpdate());
    });

    const snapshot = setup(1);
    // The same cursor every time: a re-sent snapshot at the current position is applied, not dropped as stale.
    const snapshotFrame = JSON.stringify({ cursor: 1, data: rows, epoch: "e", id: snapshot.subscriptionId, type: "data" });

    bench("full data frame", () => {
        snapshot.receive(snapshotFrame);
    });

    const optimistic = setup(1, async () => jsonResponse({ error: { code: "CONFLICT", message: "lost" } }, { status: 409 }));

    bench("optimistic update + rollback", async () => {
        await optimistic.client
            .mutation(
                fnRef("todos:toggle"),
                {},
                {
                    optimisticUpdate: (store) => {
                        const current = store.getQuery(LIST, {}) as Record<string, unknown>[];

                        store.setQuery(
                            LIST,
                            {},
                            current.map((entry, index) => (index === 500 ? { ...entry, done: !entry["done"] } : entry)),
                        );
                    },
                },
            )
            .catch(() => undefined);
    });
});
