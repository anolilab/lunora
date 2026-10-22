import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createSocketHarness, fnRef, settle } from "./lib/harness";

const never = (): Promise<string> =>
    new Promise<string>(() => {
        /* a mint endpoint that never answers */
    });

describe("wsTicket provider timeout", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("stops waiting on a hung provider and mints again on the reconnect", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        let mints = 0;
        const client = new LunoraClient({
            connectTimeoutMs: 100,
            fetch: vi.fn<typeof fetch>(),
            heartbeatIntervalMs: 0,
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "http://app.test",
            WebSocket,
            wsTicket: async () => {
                mints += 1;

                return mints === 1 ? never() : "eph-2";
            },
        });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await settle();

        expect(client.connectionStatus()).toBe("connecting");

        await vi.advanceTimersByTimeAsync(150);

        expect(mints).toBe(2);
        expect(sockets.some((socket) => socket.url.includes("token=eph-2"))).toBe(true);

        client.close();
    });

    it("ignores a provider answer that arrives after its attempt timed out", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const { sockets, WebSocket } = createSocketHarness();
        const pending: { release?: (token: string) => void } = {};
        let mints = 0;
        const client = new LunoraClient({
            connectTimeoutMs: 100,
            fetch: vi.fn<typeof fetch>(),
            heartbeatIntervalMs: 0,
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "http://app.test",
            WebSocket,
            wsTicket: async () => {
                mints += 1;

                if (mints === 1) {
                    return new Promise<string>((resolve) => {
                        pending.release = resolve;
                    });
                }

                return "eph-2";
            },
        });

        client.subscribe(fnRef("todos.list"), {}, () => undefined);
        await vi.advanceTimersByTimeAsync(150);

        const before = sockets.length;

        pending.release?.("stale-token");
        await settle();

        expect(sockets).toHaveLength(before);
        expect(sockets.some((socket) => socket.url.includes("stale-token"))).toBe(false);

        client.close();
    });
});
