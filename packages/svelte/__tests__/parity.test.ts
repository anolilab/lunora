import type { LunoraClient } from "@lunora/client";
import type { Readable } from "svelte/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AdapterDriver, Mounted } from "../../client/__tests__/lib/adapter-scenarios";
import { PRESENCE, scenarios } from "../../client/__tests__/lib/adapter-scenarios";
import { mutation } from "../src/mutation";
import { presence } from "../src/presence";
import { query } from "../src/query";
import { subscription } from "../src/subscription";

/** A store is live only while something subscribes to it — the `{$store}` a component template would hold. */
const mountStore = <T>(store: Readable<T>, teardown?: () => void): Mounted<T> => {
    let latest: T | undefined;
    const unsubscribe = store.subscribe((value) => {
        latest = value;
    });

    return {
        current: () => latest as T,
        dispose: () => {
            unsubscribe();
            teardown?.();
        },
    };
};

const driver: AdapterDriver = {
    act: async (fn) => {
        await fn();
    },
    mutation: (client, ref) => {
        const { mutate } = mutation(client as LunoraClient, ref);

        return { current: () => mutate, dispose: () => undefined };
    },
    presence: (client, { intervalMs }) => {
        const handle = presence(client as LunoraClient, PRESENCE.roomId, {
            heartbeat: PRESENCE.heartbeat,
            intervalMs,
            listPresent: PRESENCE.listPresent,
            sessionId: PRESENCE.sessionId,
        });

        return mountStore(handle.present, handle.teardown);
    },
    query: (client, ref, args, options) => mountStore(query(client as LunoraClient, ref, args, options)),
    subscription: (client, ref, args, { onError }) => mountStore(subscription(client as LunoraClient, ref, args, { onError }).data),
};

describe("@lunora/svelte behavioural parity", () => {
    // Every subscribing primitive gates on a browser `window` (SSR guard); the env is `node`.
    beforeAll(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterAll(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it.each(scenarios)("$name", async ({ run }) => {
        expect.hasAssertions();

        await run(driver);
    });
});
