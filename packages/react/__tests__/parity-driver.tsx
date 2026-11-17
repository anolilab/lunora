import type { LunoraClient } from "@lunora/client";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";

import type { AdapterDriver, Mounted } from "../../client/__tests__/lib/adapter-scenarios";
import { PRESENCE } from "../../client/__tests__/lib/adapter-scenarios";
import type { LunoraProvider, useMutation, usePresence, useQuery, useSubscription } from "../src";

/** The hooks a driver needs — taken as a parameter so `@lunora/react-native`'s barrel can be driven the same way. */
interface ReactHooks {
    LunoraProvider: typeof LunoraProvider;
    useMutation: typeof useMutation;
    usePresence: typeof usePresence;
    useQuery: typeof useQuery;
    useSubscription: typeof useSubscription;
}

/** Mounts each hook under `LunoraProvider` with Testing Library; `dispose` unmounts the tree. */
const createReactDriver = (hooks: ReactHooks): AdapterDriver => {
    const { LunoraProvider: Provider } = hooks;

    const mount = <T,>(client: unknown, useProbe: () => T): Mounted<T> => {
        let latest: T | undefined;

        const Probe = (): ReactNode => {
            latest = useProbe();

            return null;
        };

        const { unmount } = render(
            <Provider client={client as LunoraClient}>
                <Probe />
            </Provider>,
        );

        return { current: () => latest as T, dispose: unmount };
    };

    return {
        act: async (fn) => {
            await act(async () => {
                await fn();
            });
        },
        mutation: (client, ref) => mount(client, () => hooks.useMutation(ref).mutate),
        presence: (client, { intervalMs }) =>
            mount(
                client,
                () =>
                    hooks.usePresence(PRESENCE.roomId, {
                        heartbeat: PRESENCE.heartbeat,
                        intervalMs,
                        listPresent: PRESENCE.listPresent,
                        sessionId: PRESENCE.sessionId,
                    }).present,
            ),
        query: (client, ref, args, options) => mount(client, () => hooks.useQuery(ref, args, options)),
        subscription: (client, ref, args, { onError }) => mount(client, () => hooks.useSubscription(ref, args, { onError }).data),
    };
};

export default createReactDriver;
