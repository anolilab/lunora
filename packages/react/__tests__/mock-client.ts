import type { ConnectionStatus, FunctionReference, LunoraClient, SubscriptionError, SubscriptionErrorCallback, Unsubscribe, User } from "@lunora/client";
import { vi } from "vitest";

interface MockClientHooks {
    acquireConnectionContext: ReturnType<typeof vi.fn>;
    action: ReturnType<typeof vi.fn>;
    asClient: LunoraClient;
    close: ReturnType<typeof vi.fn>;
    connectionStatus: ReturnType<typeof vi.fn>;
    currentIdentity: ReturnType<typeof vi.fn>;

    /**
     * Manually push a value to active subscribers for `ref`. When `predicate` is
     * given, only subscriptions whose subscribe-time `args` satisfy it receive the
     * value — useful for fanning distinct values to per-key flag subscriptions
     * that share one reserved channel ref.
     */
    emit: (ref: string, value: unknown, predicate?: (args: unknown) => boolean) => void;

    /**
     * Fire the subscribe-time `onError` sink for active subscribers of `ref` — the
     * server-pushed, subscription-scoped error channel (an RLS denial, a query that
     * starts failing server-side), as opposed to an attach throw.
     */
    emitError: (ref: string, error: SubscriptionError, predicate?: (args: unknown) => boolean) => void;
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
    onError: SubscriptionErrorCallback | undefined;
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
    const subscribeFunction = vi.fn<
        (reference: FunctionReference, args: unknown, callback: (value: unknown) => void, options?: { onError?: SubscriptionErrorCallback }) => Unsubscribe
    >((reference: FunctionReference, args: unknown, callback: (value: unknown) => void, options?: { onError?: SubscriptionErrorCallback }): Unsubscribe => {
        const entry: SubEntry = { args, callback, onError: options?.onError, ref: reference.__lunoraRef };

        subs.add(entry);

        return () => {
            subs.delete(entry);
        };
    });
    const authListeners = new Set<(token: string | null) => void>();
    // Mirrors the real client's identity fingerprint: the SUBJECT when one was
    // supplied, else the token itself. A same-subject JWT refresh therefore
    // changes the token (firing the listeners) without moving the identity —
    // exactly the distinction consumers of `currentIdentity()` branch on.
    let authSubject: string | null | undefined;
    const setAuthTokenFunction = vi.fn<(token: string | null, subject?: string | null) => void>((token: string | null, subject?: string | null) => {
        if (subject !== undefined) {
            authSubject = subject;
        } else if (token === null) {
            authSubject = undefined;
        }

        if (authToken === token) {
            return;
        }

        authToken = token;

        for (const listener of authListeners) {
            listener(token);
        }
    });
    const getAuthTokenFunction = vi.fn<() => string | null>(() => authToken);
    const currentIdentityFunction = vi.fn<() => string | null>(() => authSubject ?? authToken);
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

    const emitError = (ref: string, error: SubscriptionError, predicate?: (args: unknown) => boolean): void => {
        for (const entry of subs) {
            if (entry.ref === ref && (predicate === undefined || predicate(entry.args))) {
                entry.onError?.(error);
            }
        }
    };

    const asClient = {
        acquireConnectionContext: acquireConnectionContextFunction,
        action: actionFunction,
        close: closeFunction,
        connectionStatus: connectionStatusFunction,
        currentIdentity: currentIdentityFunction,
        getAuthToken: getAuthTokenFunction,
        getCurrentUser: getCurrentUserFunction,
        mutation: mutationFunction,
        onAuthTokenChange: onAuthTokenChangeFunction,
        onConnectionStatus: onConnectionStatusFunction,
        // The PUBLIC getter the hooks read (`client.isReady`), not the private
        // `readyResolved` field behind it — this object is a plain literal cast
        // to `LunoraClient`, so naming the backing field left every consumer
        // reading `undefined` and the hydrated branch permanently untaken.
        isReady: true,
        peekHydratedQuery: () => undefined,
        query: queryFunction,
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
        currentIdentity: currentIdentityFunction,
        emit,
        emitError,
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
