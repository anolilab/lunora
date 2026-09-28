import type { FunctionReference, LunoraClient, Preloaded } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { describe, expect, it } from "vitest";

import { useLunora } from "../src/context";
import { createQuery } from "../src/create-query";
import hydratePreloaded from "../src/hydrate-preloaded";
import { LunoraProvider } from "../src/lunora-provider";
import { createFakeClient } from "./fake-client";

describe(LunoraProvider, () => {
    it("wires the client so useLunora resolves it from context", () => {
        const fake = createFakeClient();
        let resolved: unknown;

        render(
            () => {
                resolved = useLunora();

                return <div>ok</div>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(resolved).toBe(fake.asClient);
    });

    it("throws a helpful error when a primitive is used outside a provider", () => {
        expect(() => {
            render(() => {
                useLunora();

                return <div>nope</div>;
            });
        }).toThrow("useLunora must be used inside <LunoraProvider />");
    });

    describe("swapping the client prop", () => {
        const listRef = { __lunoraRef: "messages:list" } as FunctionReference;
        const preloaded = {
            __lunoraPreloaded: true,
            args: { channelId: "c" },
            functionPath: "messages:list",
            value: { messages: ["from-ssr"] },
        } as Preloaded<{ messages: string[] }>;

        it("moves a mounted query to the new client with no stale data and no leak on the old one", () => {
            const first = createFakeClient();
            const second = createFakeClient();
            const [client, setClient] = createSignal<LunoraClient>(first.asClient);

            const Messages = () => {
                const data = createQuery(listRef, { channelId: "c" });

                return <pre>{data() === undefined ? "loading" : JSON.stringify(data())}</pre>;
            };

            const { container } = render(() => (
                <LunoraProvider client={client()}>
                    <Messages />
                </LunoraProvider>
            ));

            first.subscriptions[0]?.push({ messages: ["old"] });

            expect(container.textContent).toBe(JSON.stringify({ messages: ["old"] }));

            setClient(second.asClient);

            expect(first.subscriptions.every((sub) => sub.unsubscribed)).toBe(true);
            expect(second.subscriptions).toHaveLength(1);
            expect(container.textContent).toBe("loading");

            second.subscriptions[0]?.push({ messages: ["new"] });

            expect(container.textContent).toBe(JSON.stringify({ messages: ["new"] }));
        });

        it("hands a component created after the swap the new client", () => {
            const first = createFakeClient();
            const second = createFakeClient();
            const [client, setClient] = createSignal<LunoraClient>(first.asClient);
            const [shown, setShown] = createSignal(false);
            let resolved: LunoraClient | undefined;

            const Late = () => {
                resolved = useLunora();
                createQuery(listRef, { channelId: "c" });

                return <div />;
            };

            render(() => (
                <LunoraProvider client={client()}>
                    <Show when={shown()}>
                        <Late />
                    </Show>
                </LunoraProvider>
            ));

            setClient(second.asClient);
            setShown(true);

            expect(resolved).toBe(second.asClient);
            expect(first.subscriptions).toHaveLength(0);
            expect(second.subscriptions).toHaveLength(1);
        });

        it("never seeds a preloaded value from before the swap", () => {
            const first = createFakeClient();
            const second = createFakeClient();
            const [client, setClient] = createSignal<LunoraClient>(first.asClient);
            const [shown, setShown] = createSignal(false);

            const Hydrated = (props: { label: string }) => {
                const data = hydratePreloaded(preloaded);

                return <pre>{`${props.label}:${JSON.stringify(data() ?? null)}`}</pre>;
            };

            const { container } = render(() => (
                <LunoraProvider client={client()}>
                    <Hydrated label="early" />
                    <Show when={shown()}>
                        <Hydrated label="late" />
                    </Show>
                </LunoraProvider>
            ));

            expect(container.textContent).toBe(`early:${JSON.stringify({ messages: ["from-ssr"] })}`);

            setClient(second.asClient);
            setShown(true);

            // Neither the hook mounted before the swap nor the one mounted after
            // it may render the first client's server-preloaded rows.
            expect(container.textContent).toBe("early:nulllate:null");
            expect(first.subscriptions.every((sub) => sub.unsubscribed)).toBe(true);
            expect(second.subscriptions).toHaveLength(2);
        });

        it("does not re-seed the preloaded value after swapping back to the first client", () => {
            const first = createFakeClient();
            const second = createFakeClient();
            const [client, setClient] = createSignal<LunoraClient>(first.asClient);

            const Hydrated = () => {
                const data = hydratePreloaded(preloaded);

                return <pre>{JSON.stringify(data() ?? null)}</pre>;
            };

            const { container } = render(() => (
                <LunoraProvider client={client()}>
                    <Hydrated />
                </LunoraProvider>
            ));

            setClient(second.asClient);
            setClient(first.asClient);

            expect(container.textContent).toBe("null");
        });

        it("does not resubscribe when the provider re-reads the same client", () => {
            const fake = createFakeClient();
            const [client, setClient] = createSignal<LunoraClient>(fake.asClient, { equals: false });

            const Messages = () => {
                createQuery(listRef, { channelId: "c" });

                return <div />;
            };

            render(() => (
                <LunoraProvider client={client()}>
                    <Messages />
                </LunoraProvider>
            ));

            setClient(fake.asClient);

            expect(fake.subscriptions).toHaveLength(1);
            expect(fake.subscriptions[0]?.unsubscribed).toBe(false);
        });
    });
});
