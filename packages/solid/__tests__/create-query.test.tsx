import type { FunctionReference } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";

import { createQuery } from "../src/create-query";
import { LunoraProvider } from "../src/lunora-provider";
import { createFakeClient } from "./fake-client";

const listRef = { __lunoraRef: "messages:list" } as FunctionReference;

describe(createQuery, () => {
    it("reads undefined until the first frame, then updates on every push", () => {
        const fake = createFakeClient();

        const { container } = render(
            () => {
                const data = createQuery(listRef, { channelId: "channel:demo" }, { shardKey: "channel:demo" });

                return <pre>{data() === undefined ? "loading" : JSON.stringify(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(container.textContent).toBe("loading");
        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.shardKey).toBe("channel:demo");

        fake.subscriptions[0]?.push({ messages: ["a"] });

        expect(container.textContent).toBe(JSON.stringify({ messages: ["a"] }));
    });

    it("opens no subscription when args is 'skip'", () => {
        const fake = createFakeClient();

        render(
            () => {
                const data = createQuery(listRef, "skip");

                return <pre>{String(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.subscriptions).toHaveLength(0);
    });

    it("re-subscribes when reactive args change, tearing down the old subscription", () => {
        const fake = createFakeClient();
        const [channelId, setChannelId] = createSignal("channel:a");

        render(
            () => {
                const data = createQuery(listRef, () => {
                    return { channelId: channelId() };
                });

                return <pre>{data() === undefined ? "loading" : JSON.stringify(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.args).toStrictEqual({ channelId: "channel:a" });
        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);

        // Change the reactive args: the old subscription must be torn down and a
        // fresh one opened for the new args.
        setChannelId("channel:b");

        expect(fake.subscriptions).toHaveLength(2);
        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
        expect(fake.subscriptions[1]?.args).toStrictEqual({ channelId: "channel:b" });
        expect(fake.subscriptions[1]?.unsubscribed).toBe(false);
    });

    it("tears down the subscription on unmount", () => {
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
});
