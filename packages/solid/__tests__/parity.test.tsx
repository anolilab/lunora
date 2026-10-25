import type { LunoraClient } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import type { AdapterDriver, Mounted } from "../../client/__tests__/lib/adapter-scenarios";
import { PRESENCE, scenarios } from "../../client/__tests__/lib/adapter-scenarios";
import { createMutation } from "../src/create-mutation";
import { createPresence } from "../src/create-presence";
import { createQuery } from "../src/create-query";
import { createSubscription } from "../src/create-subscription";
import { LunoraProvider } from "../src/lunora-provider";

const mount = <T,>(client: unknown, setup: () => () => T): Mounted<T> => {
    let read: (() => T) | undefined;

    const { unmount } = render(
        () => {
            read = setup();

            return <div />;
        },
        { wrapper: (props) => <LunoraProvider client={client as LunoraClient}>{props.children}</LunoraProvider> },
    );

    return { current: () => read!(), dispose: unmount };
};

const driver: AdapterDriver = {
    act: async (fn) => {
        await fn();
    },
    mutation: (client, ref) =>
        mount(client, () => {
            const { mutate } = createMutation(ref);

            return () => mutate;
        }),
    presence: (client, { intervalMs }) =>
        mount(
            client,
            () =>
                createPresence(PRESENCE.roomId, {
                    heartbeat: PRESENCE.heartbeat,
                    intervalMs,
                    listPresent: PRESENCE.listPresent,
                    sessionId: PRESENCE.sessionId,
                }).present,
        ),
    query: (client, ref, args, options) => mount(client, () => createQuery(ref, args, options)),
    subscription: (client, ref, args, { onError }) => mount(client, () => createSubscription(ref, args, { onError }).data),
};

describe("@lunora/solid behavioural parity", () => {
    it.each(scenarios)("$name", async ({ run }) => {
        expect.hasAssertions();

        await run(driver);
    });
});
