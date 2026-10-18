import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import type { PersistenceAdapter } from "../src/types";
import { createSocketHarness, fnRef, jsonResponse, settle } from "./lib/harness";

const createClient = (
    persistence: PersistenceAdapter,
    { subscribe = true }: { subscribe?: boolean } = {},
    fetchImpl: typeof fetch = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } })),
) => {
    const { sockets, WebSocket } = createSocketHarness();
    const client = new LunoraClient({
        fetch: fetchImpl,
        heartbeatIntervalMs: 0,
        offlineQueue: { queueBeforeFirstConnect: true },
        persistence,
        url: "http://app.test",
        WebSocket,
    });

    if (subscribe) {
        client.subscribe(fnRef("todos.list"), {}, () => undefined);
    }

    return { client, fetchImpl, sockets };
};

describe("offline queue durability", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("does not leave a record behind when the write replays before its append landed", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const inner = createInMemoryPersistence();
        let openGate: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            openGate = resolve;
        });
        const slow: PersistenceAdapter = {
            ...inner,
            append: async (mutation) => {
                await gate;
                await inner.append(mutation);
            },
        };
        const { client, sockets } = createClient(slow);
        const write = client.mutation(fnRef("todos.set"), { text: "a" });

        await settle();
        sockets[0]?.open();
        await settle();
        await write;

        // The replay settled and removed its record while the append was still pending; now it lands.
        openGate();
        await settle();

        await expect(inner.load()).resolves.toStrictEqual([]);

        client.close();
    });

    it("re-persists a write whose append failed when the page is hidden, and stops listening once closed", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const windowTarget = new EventTarget();
        const documentTarget = Object.assign(new EventTarget(), { visibilityState: "hidden" });

        vi.stubGlobal("addEventListener", windowTarget.addEventListener.bind(windowTarget));
        vi.stubGlobal("removeEventListener", windowTarget.removeEventListener.bind(windowTarget));
        vi.stubGlobal("document", documentTarget);

        const inner = createInMemoryPersistence();
        let appends = 0;
        const flaky: PersistenceAdapter = {
            ...inner,
            append: async (mutation) => {
                appends += 1;

                if (appends === 1) {
                    throw new Error("QuotaExceededError");
                }

                await inner.append(mutation);
            },
        };
        const { client } = createClient(flaky);
        const write = client.mutation(fnRef("todos.set"), { text: "a" });

        write.catch(() => undefined);
        await settle();

        await expect(inner.load()).resolves.toStrictEqual([]);

        documentTarget.dispatchEvent(new Event("visibilitychange"));
        await settle();

        await expect(inner.load()).resolves.toHaveLength(1);

        client.close();
        appends = 0;
        windowTarget.dispatchEvent(new Event("pagehide"));
        await settle();

        expect(appends).toBe(0);
    });
});
