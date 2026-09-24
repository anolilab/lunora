import type { Preloaded, SubscriptionError } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import hydratePreloaded from "../src/hydrate-preloaded";
import { LunoraProvider } from "../src/lunora-provider";
import { createFakeClient } from "./fake-client";

const makePreloaded = <T,>(value: T): Preloaded<T> => {
    return {
        __lunoraPreloaded: true,
        args: { channelId: "channel:demo" },
        functionPath: "messages:list",
        shardKey: "channel:demo",
        value,
    };
};

describe(hydratePreloaded, () => {
    it("exposes the preloaded value synchronously on first render (no loading flash)", () => {
        const fake = createFakeClient();
        const preloaded = makePreloaded({ messages: ["seeded"] });

        const { container } = render(
            () => {
                const data = hydratePreloaded(preloaded);

                // The very first synchronous read must already be the SSR value —
                // not undefined — so there is no Suspense/loading window.
                return <pre>{JSON.stringify(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(container.textContent).toBe(JSON.stringify({ messages: ["seeded"] }));
    });

    it("attaches a live subscription that updates the accessor on server pushes", () => {
        const fake = createFakeClient();
        const preloaded = makePreloaded({ messages: ["seeded"] });

        const { container } = render(
            () => {
                const data = hydratePreloaded(preloaded);

                return <pre>{JSON.stringify(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        // The effect ran on mount and opened exactly one subscription, carrying
        // the token's args + shardKey through to the client.
        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.functionPath).toBe("messages:list");
        expect(fake.subscriptions[0]?.shardKey).toBe("channel:demo");

        // A server delta flows into the same signal — the UI goes live.
        fake.subscriptions[0]?.push({ messages: ["seeded", "live"] });

        expect(container.textContent).toBe(JSON.stringify({ messages: ["seeded", "live"] }));
    });

    it("forwards onError so a server-pushed subscription error reaches the caller", () => {
        // Regression: the live subscription behind the SSR seed had no error
        // channel, so a session expiry after hydration was fanned to nobody and
        // the snapshot kept rendering as if it were live.
        const fake = createFakeClient();
        const errors: SubscriptionError[] = [];

        render(
            () => {
                const data = hydratePreloaded(makePreloaded("seed"), { onError: (error) => errors.push(error) });

                return <pre>{data()}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        fake.subscriptions[0]?.error({ code: "UNAUTHORIZED", message: "session expired" });

        expect(errors).toStrictEqual([{ code: "UNAUTHORIZED", message: "session expired" }]);
    });

    it("tears down the subscription when the owner is disposed", () => {
        const fake = createFakeClient();
        const preloaded = makePreloaded({ messages: [] });

        const { unmount } = render(
            () => {
                const data = hydratePreloaded(preloaded);

                return <pre>{JSON.stringify(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);

        unmount();

        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
    });
});
