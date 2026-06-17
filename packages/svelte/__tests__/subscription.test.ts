import type { FunctionReference, LunoraClient } from "@lunora/client";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";

import { subscription } from "../src/subscription";

const fnRef = { __lunoraRef: "messages:subscribe" } as unknown as FunctionReference;
const args = { channelId: "c1" } as unknown;

const createFakeClient = () => {
    const unsubscribeSpy = vi.fn();
    let lastCallback: ((value: unknown) => void) | undefined;

    const subscribeSpy = vi.fn((_fn: unknown, _args: unknown, callback: (value: unknown) => void, _options?: unknown) => {
        lastCallback = callback;

        return unsubscribeSpy;
    });

    const client = { subscribe: subscribeSpy } as unknown as LunoraClient;

    return { client, emit: (value: unknown) => lastCallback?.(value), subscribeSpy, unsubscribeSpy };
};

describe("subscription store", () => {
    it("data is undefined before any push", () => {
        const { client } = createFakeClient();
        const { data } = subscription(client, fnRef, args);

        // data store is lazy — no subscription until first subscriber
        const stop = data.subscribe(() => {});

        expect(get(data)).toBeUndefined();

        stop();
    });

    it("opens subscription on first data subscriber and closes on stop", () => {
        const { client, subscribeSpy, unsubscribeSpy } = createFakeClient();
        const { data } = subscription(client, fnRef, args, { shardKey: "c1" });

        const stop = data.subscribe(() => {});

        expect(subscribeSpy).toHaveBeenCalledTimes(1);

        stop();

        expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    });

    it("delivers server pushes to data store", () => {
        const { client, emit } = createFakeClient();
        const { data } = subscription(client, fnRef, args);

        const seen: unknown[] = [];
        const stop = data.subscribe((v) => seen.push(v));

        emit([{ id: "1" }]);
        emit([{ id: "1" }, { id: "2" }]);

        expect(seen).toStrictEqual([undefined, [{ id: "1" }], [{ id: "1" }, { id: "2" }]]);

        stop();
    });

    it("opens no subscription when args is 'skip'", () => {
        const { client, subscribeSpy } = createFakeClient();
        const { data } = subscription(client, fnRef, "skip");

        const stop = data.subscribe(() => {});

        expect(subscribeSpy).not.toHaveBeenCalled();

        stop();
    });
});
