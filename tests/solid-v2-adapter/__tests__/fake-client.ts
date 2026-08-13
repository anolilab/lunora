/* eslint-disable no-underscore-dangle -- `__lunoraRef` is the Lunora function-reference field the wire types expose; fixtures mirror it verbatim. */
import type { ConnectionStatus, FunctionReference, LunoraClient, Unsubscribe } from "@lunora/client";

/**
 * A minimal stand-in for `LunoraClient` covering just the surface these tests
 * drive: `subscribe`, `mutation`, and the connection-status listener.
 *
 * Deliberately a trimmed sibling of `packages/solid/__tests__/fake-client.ts`
 * rather than a shared import — that fixture also fakes streams and pulls in
 * `@lunora/client`'s stream helpers, and this suite's job is to prove the
 * adapter links and reacts under Solid 2.0, not to re-run the 1.x matrix.
 */
export interface FakeSubscription {
    args: Record<string, unknown>;
    functionPath: string;
    push: (value: unknown) => void;
    shardKey?: string;
    unsubscribed: boolean;
}

export interface FakeClient {
    /** As a typed `LunoraClient` for passing through the provider. */
    asClient: LunoraClient;
    /** Drive a connection-status transition to every registered listener. */
    emitConnectionStatus: (status: ConnectionStatus) => void;
    /** How many status listeners are still registered — proves teardown actually ran. */
    listenerCount: () => number;
    mutationCalls: { args: unknown; functionPath: string }[];
    subscriptions: FakeSubscription[];
}

export const createFakeClient = (): FakeClient => {
    const subscriptions: FakeSubscription[] = [];
    const mutationCalls: { args: unknown; functionPath: string }[] = [];
    const statusListeners = new Set<(status: ConnectionStatus) => void>();

    let status: ConnectionStatus = "idle";

    const client = {
        acquireConnectionContext: () => () => undefined,
        connectionStatus: () => status,
        mutation: (function_: FunctionReference, args: unknown) => {
            mutationCalls.push({ args, functionPath: function_.__lunoraRef });

            return Promise.resolve(args);
        },
        onConnectionStatus: (listener: (next: ConnectionStatus) => void): Unsubscribe => {
            statusListeners.add(listener);

            return () => {
                statusListeners.delete(listener);
            };
        },
        subscribe: (
            function_: FunctionReference,
            args: Record<string, unknown>,
            callback: (data: unknown) => void,
            options?: { shardKey?: string },
        ): Unsubscribe => {
            const sub: FakeSubscription = {
                args,
                functionPath: function_.__lunoraRef,
                push: callback,
                shardKey: options?.shardKey,
                unsubscribed: false,
            };

            subscriptions.push(sub);

            return () => {
                sub.unsubscribed = true;
            };
        },
    };

    return {
        asClient: client as unknown as LunoraClient,
        emitConnectionStatus: (next: ConnectionStatus) => {
            status = next;

            for (const listener of statusListeners) {
                listener(next);
            }
        },
        listenerCount: () => statusListeners.size,
        mutationCalls,
        subscriptions,
    };
};
