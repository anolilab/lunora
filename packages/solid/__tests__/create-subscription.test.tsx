import type { FunctionReference } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";

import { createSubscription } from "../src/create-subscription";
import { LunoraProvider } from "../src/lunora-provider";
import { createFakeClient } from "./fake-client";

const msgRef = { __lunoraRef: "messages:subscribe" } as FunctionReference;

describe(createSubscription, () => {
    it("returns undefined data until first push", () => {
        const fake = createFakeClient();

        const { container } = render(
            () => {
                const { data } = createSubscription(msgRef, { channelId: "c1" });

                return <pre>{data() === undefined ? "loading" : JSON.stringify(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(container.textContent).toBe("loading");
        expect(fake.subscriptions).toHaveLength(1);
    });

    it("updates on server push", () => {
        const fake = createFakeClient();

        const { container } = render(
            () => {
                const { data } = createSubscription(msgRef, { channelId: "c1" });

                return <pre>{data() === undefined ? "loading" : JSON.stringify(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        fake.subscriptions[0]?.push([{ id: "1", text: "hello" }]);

        expect(container.textContent).toBe(JSON.stringify([{ id: "1", text: "hello" }]));
    });

    it("opens no subscription when args is 'skip'", () => {
        const fake = createFakeClient();

        render(
            () => {
                const { data } = createSubscription(msgRef, "skip");

                return <pre>{String(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.subscriptions).toHaveLength(0);
    });

    it("re-subscribes when reactive args change, tearing down the old subscription", () => {
        const fake = createFakeClient();
        const [channelId, setChannelId] = createSignal("c1");

        render(
            () => {
                const { data } = createSubscription(msgRef, () => {
                    return { channelId: channelId() };
                });

                return <pre>{String(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.args).toStrictEqual({ channelId: "c1" });

        setChannelId("c2");

        expect(fake.subscriptions).toHaveLength(2);
        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
        expect(fake.subscriptions[1]?.args).toStrictEqual({ channelId: "c2" });
        expect(fake.subscriptions[1]?.unsubscribed).toBe(false);
    });

    it("clears data and tears down the subscription when args switch to 'skip'", () => {
        const fake = createFakeClient();
        const [args, setArgs] = createSignal<{ channelId: string } | "skip">({ channelId: "c1" });

        const { container } = render(
            () => {
                const { data } = createSubscription(msgRef, args);

                return <pre>{data() === undefined ? "empty" : JSON.stringify(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        fake.subscriptions[0]?.push([{ id: "1" }]);

        expect(container.textContent).toBe(JSON.stringify([{ id: "1" }]));

        setArgs("skip");

        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
        expect(container.textContent).toBe("empty");
    });

    it("tears down subscription on unmount", () => {
        const fake = createFakeClient();

        const { unmount } = render(
            () => {
                const { data } = createSubscription(msgRef, { channelId: "c1" });

                return <pre>{String(data())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);

        unmount();

        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
    });
});
