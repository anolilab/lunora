import type { FunctionReference } from "@lunora/client";
import { LunoraError } from "@lunora/errors";
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

        const { container } = render(
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

        fake.subscriptions[0]?.push("from-c1");

        expect(container.textContent).toBe("from-c1");

        setChannelId("c2");

        // The previous args' value does not survive the switch.
        expect(container.textContent).toBe("undefined");

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

    it("preserves the SubscriptionError code on the surfaced error", () => {
        const fake = createFakeClient();
        let capturedError: (() => Error | undefined) | undefined;

        render(
            () => {
                const { error } = createSubscription(msgRef, { channelId: "c1" });
                capturedError = error;

                return <pre>{String(error()?.message)}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        fake.subscriptions[0]?.error({ code: "auth-expired", message: "token expired" });

        const surfaced = capturedError!();

        expect(surfaced).toBeInstanceOf(LunoraError);
        expect((surfaced as LunoraError).code).toBe("auth-expired");
        expect(surfaced?.message).toBe("token expired");
    });

    it("surfaces a bare Error when the SubscriptionError carries no code", () => {
        const fake = createFakeClient();
        let capturedError: (() => Error | undefined) | undefined;

        render(
            () => {
                const { error } = createSubscription(msgRef, { channelId: "c1" });
                capturedError = error;

                return <pre>{String(error()?.message)}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        fake.subscriptions[0]?.error({ message: "boom" });

        const surfaced = capturedError!();

        expect(surfaced).toBeInstanceOf(Error);
        expect(surfaced).not.toBeInstanceOf(LunoraError);
        expect(surfaced?.message).toBe("boom");
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
