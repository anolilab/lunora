import type { FunctionReference, Preloaded } from "@lunora/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";

import { hydratePreloaded } from "../src/hydrate-preloaded";
import { subscribeToQuery, useQuery } from "../src/use-query";
import { createFakeClient } from "./fake-client";

const listMessages: FunctionReference = { __lunoraRef: "messages:list" };

const makePreloaded = <T>(value: T, overrides: Partial<Preloaded<T>> = {}): Preloaded<T> => {
    return {
        __lunoraPreloaded: true,
        args: { channelId: "channel:demo" },
        functionPath: "messages:list",
        value,
        ...overrides,
    };
};

describe(hydratePreloaded, () => {
    it("seeds the ref synchronously from preloaded.value on first read — no loading flash", () => {
        const fake = createFakeClient();
        const preloaded = makePreloaded(["hello", "world"]);

        const scope = effectScope();

        let data: ReturnType<typeof hydratePreloaded<string[]>> | undefined;

        scope.run(() => {
            fake.provide(() => {
                // First synchronous read: the SSR value must already be present,
                // BEFORE any subscription callback has fired.
                data = hydratePreloaded(preloaded);
            });
        });

        expect(data?.value).toStrictEqual(["hello", "world"]);
        // The subscription was opened, but its callback has NOT yet pushed —
        // proving the value came from the seed, not an async response.
        expect(fake.subscribeCalls).toHaveLength(1);

        scope.stop();
    });

    it("updates the ref when the live subscription pushes a delta, then unsubscribes on scope stop", () => {
        const fake = createFakeClient();
        const preloaded = makePreloaded(["initial"]);

        const scope = effectScope();
        let data: ReturnType<typeof hydratePreloaded<string[]>> | undefined;

        scope.run(() => {
            fake.provide(() => {
                data = hydratePreloaded(preloaded);
            });
        });

        expect(data?.value).toStrictEqual(["initial"]);

        // Server pushes a new value over the live subscription.
        fake.push("messages:list", { channelId: "channel:demo" }, ["initial", "live"]);

        expect(data?.value).toStrictEqual(["initial", "live"]);

        expect(fake.unsubscribeSpy).not.toHaveBeenCalled();

        scope.stop();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
    });

    it("forwards the shardKey from the token to client.subscribe", () => {
        const fake = createFakeClient();
        const preloaded = makePreloaded("x", { shardKey: "channel:demo" });

        const scope = effectScope();
        scope.run(() => {
            fake.provide(() => hydratePreloaded(preloaded));
        });

        expect(fake.subscribeCalls[0]?.options.shardKey).toBe("channel:demo");

        scope.stop();
    });
});

describe(subscribeToQuery, () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("warns when called with no active effect scope", () => {
        const fake = createFakeClient();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        // Called bare — no effectScope().run(...) wrapping it.
        subscribeToQuery(fake.client, listMessages, { channelId: "c1" });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("no active effect scope");
    });

    it("does not warn inside an effect scope and auto-cleans on scope.stop()", () => {
        const fake = createFakeClient();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const scope = effectScope();
        scope.run(() => {
            subscribeToQuery(fake.client, listMessages, { channelId: "c1" });
        });

        expect(warn).not.toHaveBeenCalled();
        expect(fake.unsubscribeSpy).not.toHaveBeenCalled();

        scope.stop();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
    });
});

describe(useQuery, () => {
    it("opens a subscription that is undefined until the first push, then updates", () => {
        const fake = createFakeClient();
        const scope = effectScope();
        let data: ReturnType<typeof useQuery> | undefined;

        scope.run(() => {
            fake.provide(() => {
                data = useQuery(listMessages, { channelId: "c1" });
            });
        });

        // No seed → undefined until a server value lands.
        expect(data?.value).toBeUndefined();
        expect(fake.subscribeCalls).toHaveLength(1);

        fake.push("messages:list", { channelId: "c1" }, [{ text: "hi" }]);

        expect(data?.value).toStrictEqual([{ text: "hi" }]);

        scope.stop();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
    });

    it("tears down exactly one subscription per consumer on scope.stop()", () => {
        const fake = createFakeClient();
        const scope = effectScope();

        scope.run(() => {
            fake.provide(() => {
                useQuery(listMessages, { channelId: "a" });
                useQuery(listMessages, { channelId: "b" });
            });
        });

        expect(fake.subscribeCalls).toHaveLength(2);

        scope.stop();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(2);
    });

    it("throws when no client is provided", () => {
        const scope = effectScope();

        expect(() =>
            scope.run(() => {
                useQuery(listMessages, { channelId: "c1" });
            }),
        ).toThrow("no LunoraClient provided");

        scope.stop();
    });
});
