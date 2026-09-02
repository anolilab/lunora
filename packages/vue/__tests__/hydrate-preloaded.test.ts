import type { FunctionReference, Preloaded, SubscriptionError } from "@lunora/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";

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
    // `hydratePreloaded` is built on `subscribeToQuery`, which gates its live
    // subscription on a browser `window` (SSR guard); the vitest env is
    // `node` (no `window`), so define one for these client-path tests. The
    // dedicated SSR test in the `subscribeToQuery` describe below removes it
    // to exercise the guard, mirroring `@lunora/vue`'s `use-presence.test.ts`.
    beforeEach(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

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
    // `subscribeToQuery` gates its live subscription on a browser `window`
    // (SSR guard); the vitest env is `node` (no `window`), so define one for
    // these client-path tests. The dedicated SSR test below removes it to
    // exercise the guard, mirroring `@lunora/vue`'s `use-presence.test.ts`.
    beforeEach(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
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

    it("does not subscribe during SSR (no window), but the seed still seeds the ref", () => {
        const fake = createFakeClient();

        // Simulate the server render: no browser `window`.
        Reflect.deleteProperty(globalThis, "window");

        const scope = effectScope();
        const data = scope.run(() => subscribeToQuery(fake.client, listMessages, { channelId: "c1" }, { seed: ["hello", "world"] }));

        // No live subscription opened server-side …
        expect(fake.subscribeCalls).toHaveLength(0);
        // … but the seed still gives SSR HTML its value (the `hydratePreloaded`
        // contract this primitive backs).
        expect(data?.value).toStrictEqual(["hello", "world"]);

        scope.stop();
    });
});

describe("hydratePreloaded return type", () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it("forwards onError so a server-pushed subscription error reaches the caller", () => {
        // Regression: the live subscription behind the SSR seed had no error
        // channel, so a session expiry after hydration was fanned to nobody and
        // the snapshot kept rendering as if it were live.
        const fake = createFakeClient();
        const errors: SubscriptionError[] = [];
        const scope = effectScope();

        scope.run(() => {
            fake.provide(() => {
                hydratePreloaded(makePreloaded(["seed"]), { onError: (error) => errors.push(error) });
            });
        });

        fake.subscribeCalls[0]?.options.onError?.({ code: "UNAUTHORIZED", message: "session expired" });

        expect(errors).toStrictEqual([{ code: "UNAUTHORIZED", message: "session expired" }]);

        scope.stop();
    });

    it("is Ref<T>, not Ref<T | undefined> — the seed makes undefined unreachable", () => {
        const fake = createFakeClient();
        const scope = effectScope();

        scope.run(() => {
            fake.provide(() => {
                const data = hydratePreloaded(makePreloaded(["hello"]));

                // Regression: this assignment did not compile while the return type
                // inherited `| undefined` from `subscribeToQuery` (which widens only
                // because it also serves the unseeded `useQuery` case), forcing every
                // Vue consumer to guard a state the primitive's contract forbids.
                const rows: string[] = data.value;

                expect(rows).toStrictEqual(["hello"]);
            });
        });

        scope.stop();
    });
});

describe(useQuery, () => {
    // `useQuery` gates its subscription on a browser `window` (SSR guard);
    // the vitest env is `node` (no `window`), so define one for these
    // client-path tests. The dedicated SSR test below removes it to exercise
    // the guard, mirroring `@lunora/vue`'s `use-presence.test.ts`.
    beforeEach(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

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

    it("re-subscribes when reactive args change, tearing down the previous subscription", async () => {
        const fake = createFakeClient();
        const scope = effectScope();
        const channelId = ref("a");
        let data: ReturnType<typeof useQuery> | undefined;

        scope.run(() => {
            fake.provide(() => {
                data = useQuery(listMessages, () => {
                    return { channelId: channelId.value };
                });
            });
        });

        expect(fake.subscribeCalls).toHaveLength(1);
        expect(fake.subscribeCalls[0]?.args).toStrictEqual({ channelId: "a" });

        fake.push("messages:list", { channelId: "a" }, [{ text: "from-a" }]);

        expect(data?.value).toStrictEqual([{ text: "from-a" }]);

        // Change the reactive source → the old subscription tears down and a fresh
        // one opens for the new args.
        channelId.value = "b";
        await nextTick();

        // The previous args' value must not render under the new args until the
        // new subscription's first frame lands.
        expect(data?.value).toBeUndefined();
        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
        expect(fake.subscribeCalls).toHaveLength(2);
        expect(fake.subscribeCalls[1]?.args).toStrictEqual({ channelId: "b" });

        fake.push("messages:list", { channelId: "b" }, [{ text: "from-b" }]);

        expect(data?.value).toStrictEqual([{ text: "from-b" }]);

        scope.stop();

        // Both subscriptions accounted for (one already torn down on re-key, one on stop).
        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(2);
    });

    it("opens no subscription while args resolve to 'skip', then subscribes once they don't", async () => {
        const fake = createFakeClient();
        const scope = effectScope();
        const args = ref<"skip" | { channelId: string }>("skip");
        let data: ReturnType<typeof useQuery> | undefined;

        scope.run(() => {
            fake.provide(() => {
                data = useQuery(listMessages, () => args.value);
            });
        });

        // "skip" → no network call, no socket.
        expect(fake.subscribeCalls).toHaveLength(0);
        expect(data?.value).toBeUndefined();

        args.value = { channelId: "c1" };
        await nextTick();

        expect(fake.subscribeCalls).toHaveLength(1);

        fake.push("messages:list", { channelId: "c1" }, [{ text: "hi" }]);

        expect(data?.value).toStrictEqual([{ text: "hi" }]);

        // Back to "skip" → the live subscription tears down and the ref resets.
        args.value = "skip";
        await nextTick();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
        expect(data?.value).toBeUndefined();

        scope.stop();
    });

    it("does not subscribe during SSR (no window)", () => {
        const fake = createFakeClient();

        // Simulate the server render: no browser `window`.
        Reflect.deleteProperty(globalThis, "window");

        const scope = effectScope();
        let data: ReturnType<typeof useQuery> | undefined;

        scope.run(() => {
            fake.provide(() => {
                data = useQuery(listMessages, { channelId: "c1" });
            });
        });

        expect(fake.subscribeCalls).toHaveLength(0);
        expect(data?.value).toBeUndefined();

        scope.stop();
    });

    it("forwards onError so a server-pushed subscription error reaches the caller", () => {
        // Regression: `client.subscribe` accepts `onError` and
        // `createQuerySubscription` forwards it, but `useQuery` never exposed one —
        // an RLS denial or a query that starts failing server-side left the ref
        // frozen at its last good value with nothing surfaced.
        const fake = createFakeClient();
        const scope = effectScope();
        const errors: SubscriptionError[] = [];

        scope.run(() => {
            fake.provide(() => {
                useQuery(listMessages, { channelId: "c1" }, { onError: (error) => errors.push(error) });
            });
        });

        fake.subscribeCalls[0]?.options.onError?.({ code: "FORBIDDEN", message: "row-level security denied the read" });

        expect(errors).toStrictEqual([{ code: "FORBIDDEN", message: "row-level security denied the read" }]);

        scope.stop();
    });
});
