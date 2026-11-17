// @vitest-environment jsdom
import { LunoraClient } from "@lunora/client";
import { notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { bench, describe } from "vitest";

import type { MockSocket } from "../__tests__/mock-socket";
import { createMockWebSocket } from "../__tests__/mock-socket";
import { LunoraProvider } from "../src/lunora-provider";
import Consumer from "./live-query-consumer";

/**
 * One delta frame on a 1,000-row live query, from the socket to a committed
 * React render, with N components reading the same query. Measures the client's
 * frame handling, the TanStack cache write and every consumer's re-render.
 */

const ROWS = 1000;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Flush TanStack's observer notifications synchronously, so `act` covers the whole render.
notifyManager.setScheduler((callback) => {
    callback();
});

const row = (index: number, version = 0): Record<string, unknown> => {
    return { _creationTime: index, _id: `row_${index.toString().padStart(6, "0")}`, done: index % 2 === 0, text: `todo ${index.toString()}`, version };
};

const mount = (consumers: number): (() => void) => {
    const sockets: MockSocket[] = [];
    const client = new LunoraClient({ heartbeatIntervalMs: 0, url: "http://app.test", WebSocket: createMockWebSocket(sockets) });
    const root = createRoot(document.createElement("div"));

    act(() => {
        root.render(
            <LunoraProvider client={client}>
                {Array.from({ length: consumers }, (_v, index) => (
                    <Consumer key={index} />
                ))}
            </LunoraProvider>,
        );
    });

    const socket = sockets[0]!;

    act(() => {
        socket.open();
    });

    const id = socket.sent.find((frame) => frame.type === "subscribe")!.id!;

    act(() => {
        socket.receive({ id, type: "ack" });
        socket.receive({ cursor: 1, data: Array.from({ length: ROWS }, (_v, index) => row(index)), epoch: "e", id, type: "data" });
    });

    let cursor = 1;

    return () => {
        cursor += 1;

        const index = cursor % ROWS;

        act(() => {
            socket.receive({
                cursor,
                delta: { key: `row_${index.toString().padStart(6, "0")}`, op: "update", row: row(index, cursor), table: "todos" },
                epoch: "e",
                id,
                type: "delta",
            });
        });
    };
};

describe("useQuery: one delta on a 1,000-row query", () => {
    const one = mount(1);

    bench("1 consumer", () => {
        one();
    });

    const hundred = mount(100);

    bench("100 consumers of the same query", () => {
        hundred();
    });
});
