import type { LunoraClient } from "@lunora/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, effectScope } from "vue";

import type { AdapterDriver, Mounted } from "../../client/__tests__/lib/adapter-scenarios";
import { PRESENCE, scenarios } from "../../client/__tests__/lib/adapter-scenarios";
import { LUNORA_INJECTION_KEY } from "../src/lunora-provider";
import { useMutation } from "../src/use-mutation";
import { usePresence } from "../src/use-presence";
import { useQuery } from "../src/use-query";
import { useSubscription } from "../src/use-subscription";

// Same harness as `fake-client.ts`: a throwaway app supplies `runWithContext` so `useLunora()` resolves without a DOM,
// and an effect scope stands in for the component lifetime.
const mount = <T>(client: unknown, setup: () => () => T): Mounted<T> => {
    const app = createApp({});

    app.provide(LUNORA_INJECTION_KEY, client as LunoraClient);

    const scope = effectScope();
    const read = app.runWithContext(() => scope.run(setup)) as () => T;

    return {
        current: read,
        dispose: () => {
            scope.stop();
        },
    };
};

const driver: AdapterDriver = {
    act: async (fn) => {
        await fn();
    },
    mutation: (client, ref) =>
        mount(client, () => {
            const { mutate } = useMutation(ref);

            return () => mutate;
        }),
    presence: (client, { intervalMs }) =>
        mount(client, () => {
            const { present } = usePresence(PRESENCE.roomId, {
                heartbeat: PRESENCE.heartbeat,
                intervalMs,
                listPresent: PRESENCE.listPresent,
                sessionId: PRESENCE.sessionId,
            });

            return () => present.value;
        }),
    query: (client, ref, args, options) =>
        mount(client, () => {
            const data = useQuery(ref, args, options);

            return () => data.value;
        }),
    subscription: (client, ref, args, { onError }) =>
        mount(client, () => {
            const { data } = useSubscription(ref, args, { onError });

            return () => data.value;
        }),
};

describe("@lunora/vue behavioural parity", () => {
    // The composables gate their live subscription on a browser `window` (SSR guard); the env is `node`.
    beforeAll(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterAll(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it.each(scenarios)("$name", async ({ run }) => {
        expect.hasAssertions();

        await run(driver);
    });
});
