import type { FunctionReference, Preloaded } from "@lunora/client";
import {
    createConnectionStatus,
    createMutation,
    createQuery,
    createSubscription,
    hydratePreloaded,
    LunoraContext,
    LunoraProvider,
    useLunora,
} from "@lunora/solid";
import { render } from "@solidjs/testing-library";
import * as solid from "solid-js";
import { createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";

import { createFakeClient } from "./fake-client";

const listRef = { __lunoraRef: "messages:list" } as FunctionReference;
const sendRef = { __lunoraRef: "messages:send" } as FunctionReference;

/**
 * `@lunora/solid` under Solid 2.0.
 *
 * The package supports both Solid majors from one build, and 2.0 deleted the
 * primitives the adapter used to be written against (`on`, `onMount`, the
 * single-argument `createEffect`, `Context.Provider`). `packages/solid`'s own
 * suite pins Solid 1.x, so this file is the other half of that promise: same
 * shipped bundle, opposite major.
 *
 * Reads settle on a microtask in 2.0, so a write followed by an assertion needs
 * `flush()` in between — that is a behaviour change, not a test smell.
 */
describe("@lunora/solid on Solid 2", () => {
    it("is actually running Solid 2 — the guard is only meaningful if it is", () => {
        // The suite's own Solid. `onSettled` is 2.0-only; `on` was removed in 2.0.
        expect(typeof (solid as Record<string, unknown>).onSettled).toBe("function");
        expect("on" in solid).toBe(false);

        // And the Solid the ADAPTER linked against, which is the claim that
        // matters: `@lunora/solid` is a workspace symlink, so a resolution slip
        // could hand it packages/solid's own 1.x copy and every assertion below
        // would pass while testing the wrong major. `createContext` returns a
        // bare component in 2.0 and a `{ Provider, id, defaultValue }` object in
        // 1.x, so the context's own shape settles it.
        expect(typeof LunoraContext).toBe("function");
        expect(LunoraContext).not.toHaveProperty("Provider");
    });

    it("provides the client through the 2.0 context-as-provider form", () => {
        const fake = createFakeClient();

        const { container } = render(
            () => {
                const data = createQuery(listRef, { channelId: "channel:demo" }, { shardKey: "channel:demo" });

                return <pre>{data() === undefined ? "loading" : JSON.stringify(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        // Reaching the subscription at all proves `providerOf` resolved the
        // provider: in 2.0 the context object IS the component, so the 1.x
        // `Context.Provider` lookup would have handed `createComponent` an
        // `undefined` and thrown before `useLunora` ever ran.
        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.shardKey).toBe("channel:demo");
        expect(container.textContent).toBe("loading");

        fake.subscriptions[0]?.push({ messages: ["a"] });
        flush();

        expect(container.textContent).toBe(JSON.stringify({ messages: ["a"] }));
    });

    it("re-subscribes through the split-phase effect when reactive args change", () => {
        const fake = createFakeClient();
        const [channelId, setChannelId] = createSignal("channel:a");

        render(
            () => {
                const data = createQuery(listRef, () => {
                    return { channelId: channelId() };
                });

                return <pre>{String(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.args).toStrictEqual({ channelId: "channel:a" });

        setChannelId("channel:b");
        flush();

        // This is the assertion that `trackedEffect` maps onto 2.0's
        // `createEffect(compute, apply)` correctly: the old run's returned
        // disposer must fire before the new one opens.
        expect(fake.subscriptions).toHaveLength(2);
        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
        expect(fake.subscriptions[1]?.args).toStrictEqual({ channelId: "channel:b" });
        expect(fake.subscriptions[1]?.unsubscribed).toBe(false);
    });

    it("tears the subscription down on unmount", () => {
        const fake = createFakeClient();

        const { unmount } = render(
            () => {
                const data = createQuery(listRef, { channelId: "channel:demo" });

                return <pre>{String(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);

        unmount();

        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
    });

    it("honours 'skip' without opening a subscription", () => {
        const fake = createFakeClient();

        render(
            () => {
                const { data } = createSubscription(listRef, "skip");

                return <pre>{String(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.subscriptions).toHaveLength(0);
    });

    it("seeds hydratePreloaded synchronously, then attaches a live subscription on mount", () => {
        const fake = createFakeClient();

        const preloaded = {
            args: { channelId: "channel:demo" },
            functionPath: "messages:list",
            value: { messages: ["seeded"] },
        } as unknown as Preloaded<{ messages: string[] }>;

        const { container } = render(
            () => {
                const data = hydratePreloaded(preloaded);

                return <pre>{JSON.stringify(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        // The seed must be visible on the very first read — no loading window.
        expect(container.textContent).toBe(JSON.stringify({ messages: ["seeded"] }));

        // `onMounted` maps to 2.0's `onSettled`; if that mapping were wrong the
        // subscription would never open.
        expect(fake.subscriptions).toHaveLength(1);

        fake.subscriptions[0]?.push({ messages: ["live"] });
        flush();

        expect(container.textContent).toBe(JSON.stringify({ messages: ["live"] }));
    });

    it("runs a mutation and reflects its result", async () => {
        const fake = createFakeClient();
        let handle: ReturnType<typeof createMutation> | undefined;

        render(
            () => {
                handle = createMutation(sendRef);

                return <pre>{String(handle.pending())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        await handle?.mutate({ channelId: "channel:demo", text: "hi" });
        flush();

        expect(fake.mutationCalls).toStrictEqual([{ args: { channelId: "channel:demo", text: "hi" }, functionPath: "messages:send" }]);
        expect(handle?.data()).toStrictEqual({ channelId: "channel:demo", text: "hi" });
        expect(handle?.pending()).toBe(false);
    });

    it("tracks connection-status transitions and releases the listener on unmount", () => {
        const fake = createFakeClient();

        const { container, unmount } = render(() => <pre>{createConnectionStatus()()}</pre>, {
            wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider>,
        });

        expect(container.textContent).toBe("idle");
        expect(fake.listenerCount()).toBe(1);

        fake.emitConnectionStatus("connected");
        flush();

        expect(container.textContent).toBe("connected");

        // Several primitives (`createConnectionStatus`, `createAuth`,
        // `createStream`, `createRateLimit`) register teardown with a top-level
        // `onCleanup` in the component body. Solid 2 steers app code towards
        // `onSettled` for that, so this pins the behaviour the adapter still
        // depends on — a silent no-op here would leak a listener per mount.
        unmount();

        expect(fake.listenerCount()).toBe(0);
    });

    it("names the missing provider instead of leaking Solid 2's context error", () => {
        // Solid 1.x hands back the context's `undefined` default here, so
        // `useLunora`'s guard fires. Solid 2 throws `ContextNotFoundError`
        // first, which would reach the user with no mention of the provider
        // they forgot.
        expect(() => {
            render(() => {
                useLunora();

                return <div>nope</div>;
            });
        }).toThrow("useLunora must be used inside <LunoraProvider />");
    });
});
