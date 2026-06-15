import type { FunctionReference, LunoraClient, Unsubscribe, User } from "@lunora/client";
import { vi } from "vitest";

interface MockClientHooks {
    action: ReturnType<typeof vi.fn>;
    asClient: LunoraClient;
    close: ReturnType<typeof vi.fn>;
    /** Manually push a value to all active subscribers for `ref`. */
    emit: (ref: string, value: unknown) => void;
    getAuthToken: ReturnType<typeof vi.fn>;
    getCurrentUser: ReturnType<typeof vi.fn>;
    mutation: ReturnType<typeof vi.fn>;
    onAuthTokenChange: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    setAuthToken: ReturnType<typeof vi.fn>;
    setConnectionContext: ReturnType<typeof vi.fn>;
    /** Set the user `getCurrentUser` resolves to on its next call. */
    setCurrentUser: (user: User | null) => void;
    subscribe: ReturnType<typeof vi.fn>;
}

interface SubEntry {
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
        (reference: FunctionReference, _args: unknown, callback: (value: unknown) => void): Unsubscribe => {
            const entry: SubEntry = { callback, ref: reference.__lunoraRef };

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

    let currentUser: User | null = null;
    const getCurrentUserFunction = vi.fn<() => Promise<User | null>>(async () => currentUser);
    const setCurrentUser = (user: User | null): void => {
        currentUser = user;
    };

    const emit = (ref: string, value: unknown): void => {
        for (const entry of subs) {
            if (entry.ref === ref) {
                entry.callback(value);
            }
        }
    };

    const asClient = {
        action: actionFunction,
        close: closeFunction,
        getAuthToken: getAuthTokenFunction,
        getCurrentUser: getCurrentUserFunction,
        mutation: mutationFunction,
        onAuthTokenChange: onAuthTokenChangeFunction,
        query: queryFunction,
        setAuthToken: setAuthTokenFunction,
        setConnectionContext: setConnectionContextFunction,
        subscribe: subscribeFunction,
    } as unknown as LunoraClient;

    return {
        action: actionFunction,
        asClient,
        close: closeFunction,
        emit,
        getAuthToken: getAuthTokenFunction,
        getCurrentUser: getCurrentUserFunction,
        mutation: mutationFunction,
        onAuthTokenChange: onAuthTokenChangeFunction,
        query: queryFunction,
        setAuthToken: setAuthTokenFunction,
        setConnectionContext: setConnectionContextFunction,
        setCurrentUser,
        subscribe: subscribeFunction,
    };
};

export { createMockClient };
export type { MockClientHooks };
