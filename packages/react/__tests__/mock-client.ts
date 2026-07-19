import type { ConnectionStatus, FunctionReference, LunoraClient, Unsubscribe, User } from "@lunora/client";
import { vi } from "vitest";

interface MockClientHooks {
    acquireConnectionContext: ReturnType<typeof vi.fn>;
    action: ReturnType<typeof vi.fn>;
    asClient: LunoraClient;
    close: ReturnType<typeof vi.fn>;
    connectionStatus: ReturnType<typeof vi.fn>;

    /**
     * Manually push a value to active subscribers for `ref`. When `predicate` is
     * given, only subscriptions whose subscribe-time `args` satisfy it receive the
     * value — useful for fanning distinct values to per-key flag subscriptions
     * that share one reserved channel ref.
     */
    emit: (ref: string, value: unknown, predicate?: (args: unknown) => boolean) => void;
    getAuthToken: ReturnType<typeof vi.fn>;
    getCurrentUser: ReturnType<typeof vi.fn>;
    mutation: ReturnType<typeof vi.fn>;
    onAuthTokenChange: ReturnType<typeof vi.fn>;
    onConnectionStatus: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    setAuthToken: ReturnType<typeof vi.fn>;
    setConnectionContext: ReturnType<typeof vi.fn>;
    /** Transition the aggregate connection status and notify every `onConnectionStatus` listener. */
    setConnectionStatus: (status: ConnectionStatus) => void;
    /** Set the user `getCurrentUser` resolves to on its next call. */
    setCurrentUser: (user: User | null) => void;
    subscribe: ReturnType<typeof vi.fn>;
}

interface SubEntry {
    args: unknown;
    callback: (value: unknown) => void;
    ref: string;
}

const createMockClient = (queryImpl?: (ref: string, args: unknown) => unknown): MockClientHooks => {
    const subs = new Set<SubEntry>();
    let authToken: string | null = null;

    const queryFunction = vi.fn<(reference: FunctionReference, args: unknown) => Promise<unknown>>(async (reference: FunctionReference, args: unknown) =>
        queryImpl ? queryImpl(reference.__lunoraRef, args) : undefined,
    );
    const mutationFunction = vi.fn<() => Promise<unknown>>(async () => undefined);
    const actionFunction = vi.fn<() => Promise<unknown>>(async () => undefined);
    const subscribeFunction = vi.fn<(reference: FunctionReference, args: unknown, callback: (value: unknown) => void) => Unsubscribe>(
        (reference: FunctionReference, args: unknown, callback: (value: unknown) => void): Unsubscribe => {
            const entry: SubEntry = { args, callback, ref: reference.__lunoraRef };

            subs.add(entry);

            return () => {
                subs.delete(entry);
            };
        },
    );
    const authListeners = new Set<(token: string | null) => void>();
    const setAuthTokenFunction = vi.fn<(token: string | null) => void>((token: string | null) => {
        if (authToken === token) {
            return;
        }

        authToken = token;

        for (const listener of authListeners) {
            listener(token);
        }
    });
    const getAuthTokenFunction = vi.fn<() => string | null>(() => authToken);
    const onAuthTokenChangeFunction = vi.fn<(listener: (token: string | null) => void) => Unsubscribe>(
        (listener: (token: string | null) => void): Unsubscribe => {
            authListeners.add(listener);

            return () => {
                authListeners.delete(listener);
            };
        },
    );
    const closeFunction = vi.fn<() => void>();
    const setConnectionContextFunction = vi.fn<(context: Record<string, unknown> | undefined, options?: { shardKey?: string }) => void>();
    const acquireConnectionContextFunction = vi.fn<(context: Record<string, unknown>, options?: { shardKey?: string }) => Unsubscribe>(
        (): Unsubscribe => () => undefined,
    );

    let currentUser: User | null = null;
    const getCurrentUserFunction = vi.fn<() => Promise<User | null>>(async () => currentUser);
    const setCurrentUser = (user: User | null): void => {
        currentUser = user;
    };

    // Connection-status surface. Mirrors the real client: `onConnectionStatus`
    // invokes the listener immediately with the current status, then on every
    // transition driven by `setConnectionStatus`.
    let status: ConnectionStatus = "idle";
    const statusListeners = new Set<(next: ConnectionStatus) => void>();
    const connectionStatusFunction = vi.fn<() => ConnectionStatus>(() => status);
    const onConnectionStatusFunction = vi.fn<(listener: (next: ConnectionStatus) => void) => Unsubscribe>(
        (listener: (next: ConnectionStatus) => void): Unsubscribe => {
            statusListeners.add(listener);
            listener(status);

            return () => {
                statusListeners.delete(listener);
            };
        },
    );
    const setConnectionStatus = (next: ConnectionStatus): void => {
        status = next;

        for (const listener of statusListeners) {
            listener(next);
        }
    };

    const emit = (ref: string, value: unknown, predicate?: (args: unknown) => boolean): void => {
        for (const entry of subs) {
            if (entry.ref === ref && (predicate === undefined || predicate(entry.args))) {
                entry.callback(value);
            }
        }
    };

    const asClient = {
        acquireConnectionContext: acquireConnectionContextFunction,
        action: actionFunction,
        close: closeFunction,
        connectionStatus: connectionStatusFunction,
        getAuthToken: getAuthTokenFunction,
        getCurrentUser: getCurrentUserFunction,
        mutation: mutationFunction,
        onAuthTokenChange: onAuthTokenChangeFunction,
        onConnectionStatus: onConnectionStatusFunction,
        peekHydratedQuery: () => undefined,
        query: queryFunction,
        readyResolved: true,
        setAuthToken: setAuthTokenFunction,
        setConnectionContext: setConnectionContextFunction,
        subscribe: subscribeFunction,
        whenReady: async () => undefined,
    } as unknown as LunoraClient;

    return {
        acquireConnectionContext: acquireConnectionContextFunction,
        action: actionFunction,
        asClient,
        close: closeFunction,
        connectionStatus: connectionStatusFunction,
        emit,
        getAuthToken: getAuthTokenFunction,
        getCurrentUser: getCurrentUserFunction,
        mutation: mutationFunction,
        onAuthTokenChange: onAuthTokenChangeFunction,
        onConnectionStatus: onConnectionStatusFunction,
        query: queryFunction,
        setAuthToken: setAuthTokenFunction,
        setConnectionContext: setConnectionContextFunction,
        setConnectionStatus,
        setCurrentUser,
        subscribe: subscribeFunction,
    };
};

export { createMockClient };
export type { MockClientHooks };
