import type { FunctionReference } from "@lunora/client";
import { render } from "@solidjs/testing-library";
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
