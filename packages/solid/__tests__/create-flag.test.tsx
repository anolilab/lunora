import type { LunoraClient } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";

import { createFlag, createFlags } from "../src/create-flag";
import { LunoraProvider } from "../src/lunora-provider";
import { createFakeClient } from "./fake-client";

/** The reserved reactive channel every flag read subscribes to. */
const FLAGS_REF = "__lunora_flags__:eval";

describe(createFlag, () => {
    it("subscribes on the reserved flags channel, reads the default until a value lands, then updates", () => {
        const fake = createFakeClient();

        const { container } = render(
            () => {
                const enabled = createFlag("dark-mode", false);

                return <pre>{String(enabled())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.functionPath).toBe(FLAGS_REF);
        expect(container.textContent).toBe("false");

        fake.subscriptions[0]?.push(true);

        expect(container.textContent).toBe("true");
    });

    it("sends the flag key, inferred type, and default as subscribe args", () => {
        const fake = createFakeClient();

        render(
            () => {
                const hero = createFlag("hero", "control");

                return <pre>{hero()}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.subscriptions[0]?.args).toStrictEqual({ context: undefined, default: "control", key: "hero", type: "string" });
    });

    it("re-subscribes and resets to the default when a reactive key changes", () => {
        const fake = createFakeClient();
        const [key, setKey] = createSignal("alpha");

        const { container } = render(
            () => {
                const enabled = createFlag(key, false);

                return <pre>{String(enabled())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        fake.subscriptions[0]?.push(true);

        expect(container.textContent).toBe("true");

        // A different key is a different flag — the old subscription is torn down,
        // the prior `true` dropped, and a fresh subscription opened.
        setKey("beta");

        expect(fake.subscriptions).toHaveLength(2);
        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
        expect(container.textContent).toBe("false");
    });

    it("fails open — a thrown subscribe keeps the default", () => {
        const throwing = {
            subscribe: () => {
                throw new Error("socket closed");
            },
        } as unknown as LunoraClient;

        const { container } = render(
            () => {
                const enabled = createFlag("dark-mode", false);

                return <pre>{String(enabled())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={throwing}>{props.children}</LunoraProvider> },
        );

        expect(container.textContent).toBe("false");
    });

    it("tears down the subscription on unmount", () => {
        const fake = createFakeClient();

        const { unmount } = render(
            () => {
                const enabled = createFlag("dark-mode", false);

                return <pre>{String(enabled())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);

        unmount();

        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
    });
});

describe(createFlags, () => {
    it("opens one subscription per key and resolves each independently", () => {
        const fake = createFakeClient();

        const { container } = render(
            () => {
                const flags = createFlags({ "dark-mode": false, "page-size": 10 });

                return <pre>{JSON.stringify(flags())}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(fake.subscriptions).toHaveLength(2);
        expect(container.textContent).toBe(JSON.stringify({ "dark-mode": false, "page-size": 10 }));

        fake.subscriptions.find((sub) => sub.args["key"] === "dark-mode")?.push(true);
        fake.subscriptions.find((sub) => sub.args["key"] === "page-size")?.push(50);

        expect(container.textContent).toBe(JSON.stringify({ "dark-mode": true, "page-size": 50 }));
    });
});
