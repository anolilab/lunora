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

        const { container } = render(
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

        fake.subscriptions[0]?.push(["from-a"]);

        expect(container.textContent).toBe(JSON.stringify(["from-a"]));

        // Change the reactive args: the old subscription must be torn down and a
        // fresh one opened for the new args — and the old args' value must not
        // render under the new args until the new subscription's first frame.
        setChannelId("channel:b");

        expect(container.textContent).toBe("loading");

        expect(fake.subscriptions).toHaveLength(2);
        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
        expect(fake.subscriptions[1]?.args).toStrictEqual({ channelId: "channel:b" });
        expect(fake.subscriptions[1]?.unsubscribed).toBe(false);
    });

    it("forwards onError so a server-pushed subscription error reaches the caller", () => {
        // Regression: `createQuerySubscription` accepts an `onError` sink but
        // `createQuery` never exposed one — an RLS denial or a query that starts
        // failing server-side left the accessor frozen at its last good value.
        const fake = createFakeClient();
        const errors: { code?: string; message: string }[] = [];

        render(
            () => {
                const data = createQuery(
                    listRef,
                    { channelId: "channel:demo" },
                    {
                        onError: (error) => {
                            errors.push(error);
                        },
                    },
                );

                return <pre>{String(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        fake.subscriptions[0]?.error({ code: "FORBIDDEN", message: "row-level security denied the read" });

        expect(errors).toStrictEqual([{ code: "FORBIDDEN", message: "row-level security denied the read" }]);
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
