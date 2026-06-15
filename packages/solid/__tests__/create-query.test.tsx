import type { FunctionReference } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { createQuery } from "../src/create-query";
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
});
