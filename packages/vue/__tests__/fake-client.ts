import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, SubscriptionErrorCallback, Unsubscribe } from "@lunora/client";
import { vi } from "vitest";
import { createApp } from "vue";

import { LUNORA_INJECTION_KEY } from "../src/lunora-provider";

interface SubscribeCall {
    args: Record<string, unknown>;
    callback: (data: unknown) => void;
    functionPath: string;
    options: { onError?: SubscriptionErrorCallback; shardKey?: string };
}

/**
 * A hand-rolled stand-in for `LunoraClient` exposing just the surface the Vue
 * composables touch (`subscribe`, `mutation`). Records every subscribe call,
 * lets a test push values to a live subscription, and spies on unsubscribe so we
 * can assert teardown. No WebSocket, no network — pure in-memory.
 */
interface FakeClient {
    /** The fake typed as a `LunoraClient` for passing into the composables. */
    client: LunoraClient;
    /** A recorded mock of `mutation` so tests can assert calls/resolve a value. */
    mutationSpy: ReturnType<typeof vi.fn>;
    /** Run `fn` with this fake provided as the Lunora client (no component mount). */
    provide: <T>(fn: () => T) => T;
    /** Push `value` to every callback subscribed for `(functionPath, args)`. */
    push: (functionPath: string, args: Record<string, unknown>, value: unknown) => void;
    /** Every `subscribe` call made against the fake, in order. */
    subscribeCalls: SubscribeCall[];
    /** Spy invoked each time a subscription's returned `Unsubscribe` runs. */
    unsubscribeSpy: ReturnType<typeof vi.fn>;
}

const keyOf = (functionPath: string, args: Record<string, unknown>): string => `${functionPath}::${JSON.stringify(args)}`;

const createFakeClient = (): FakeClient => {
    const subscribeCalls: SubscribeCall[] = [];
    const unsubscribeSpy = vi.fn<() => void>();
    const mutationSpy = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined);

    // A throwaway Vue app gives us a real `runWithContext` so `inject`/`provide`
    // resolve without mounting a component into a DOM.
    const app = createApp({});

    const subscribe = <F extends FunctionReference>(
        function_: F,
        args: ArgsOf<F>,
        callback: (data: ReturnOf<F>) => void,
        options: { onError?: SubscriptionErrorCallback; shardKey?: string } = {},
    ): Unsubscribe => {
        subscribeCalls.push({
            args: args ?? {},
            callback: callback as (data: unknown) => void,
            // Bracket access — this package's eslint config has no underscore
            // allow-list, and `__lunoraRef` is the real public marker field.
            functionPath: function_["__lunoraRef"],
            options,
        });

        return () => {
            unsubscribeSpy();
        };
    };

    const fake = { mutation: mutationSpy, subscribe } as unknown as LunoraClient;

    // Install the fake into the app's provide context up front so
    // `useLunora()` resolves it inside `runWithContext`.
    app.provide(LUNORA_INJECTION_KEY, fake);

    const provide = <T>(fn: () => T): T => app.runWithContext(fn);

    const push = (functionPath: string, args: Record<string, unknown>, value: unknown): void => {
        const target = keyOf(functionPath, args);

        for (const call of subscribeCalls) {
            if (keyOf(call.functionPath, call.args) === target) {
                call.callback(value);
            }
        }
    };

    return { client: fake, mutationSpy, provide, push, subscribeCalls, unsubscribeSpy };
};

export type { FakeClient };
export { createFakeClient };
