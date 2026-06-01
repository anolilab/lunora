import type { CirrusClient, FunctionReference, Unsubscribe } from "@cirrus/client";
import { vi } from "vitest";

export interface MockClientHooks {
    action: ReturnType<typeof vi.fn>;
    asClient: CirrusClient;
    close: ReturnType<typeof vi.fn>;
    /** Manually push a value to all active subscribers for `ref`. */
    emit: (ref: string, value: unknown) => void;
    getAuthToken: ReturnType<typeof vi.fn>;
    mutation: ReturnType<typeof vi.fn>;
    onAuthTokenChange: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    setAuthToken: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
}

interface SubEntry {
    callback: (value: unknown) => void;
    ref: string;
}

export const createMockClient = (queryImpl?: (ref: string, args: unknown) => unknown): MockClientHooks => {
    const subs = new Set<SubEntry>();
    let authToken: string | null = null;

    const queryFn = vi.fn<(fn: FunctionReference, args: unknown) => Promise<unknown>>(async (fn: FunctionReference, args: unknown) => {
        return queryImpl ? queryImpl(fn.__cirrusRef, args) : undefined;
    });
    const mutationFn = vi.fn<() => Promise<unknown>>(async () => undefined as unknown);
    const actionFn = vi.fn<() => Promise<unknown>>(async () => undefined as unknown);
    const subscribeFn = vi.fn<(fn: FunctionReference, args: unknown, cb: (value: unknown) => void) => Unsubscribe>(
        (fn: FunctionReference, _args: unknown, cb: (value: unknown) => void): Unsubscribe => {
            const entry: SubEntry = { ref: fn.__cirrusRef, callback: cb };

            subs.add(entry);

            return () => {
                subs.delete(entry);
            };
        },
    );
    const authListeners = new Set<(token: string | null) => void>();
    const setAuthTokenFn = vi.fn<(token: string | null) => void>((token: string | null) => {
        if (authToken === token) {
            return;
        }

        authToken = token;

        for (const listener of authListeners) {
            listener(token);
        }
    });
    const getAuthTokenFn = vi.fn<() => string | null>(() => authToken);
    const onAuthTokenChangeFn = vi.fn<(listener: (token: string | null) => void) => Unsubscribe>((listener: (token: string | null) => void): Unsubscribe => {
        authListeners.add(listener);

        return () => {
            authListeners.delete(listener);
        };
    });
    const closeFn = vi.fn<() => void>();

    const emit = (ref: string, value: unknown): void => {
        for (const entry of subs) {
            if (entry.ref === ref) {
                entry.callback(value);
            }
        }
    };

    const asClient = {
        query: queryFn,
        mutation: mutationFn,
        action: actionFn,
        subscribe: subscribeFn,
        setAuthToken: setAuthTokenFn,
        getAuthToken: getAuthTokenFn,
        onAuthTokenChange: onAuthTokenChangeFn,
        close: closeFn,
    } as unknown as CirrusClient;

    return {
        query: queryFn,
        mutation: mutationFn,
        action: actionFn,
        subscribe: subscribeFn,
        setAuthToken: setAuthTokenFn,
        getAuthToken: getAuthTokenFn,
        onAuthTokenChange: onAuthTokenChangeFn,
        close: closeFn,
        emit,
        asClient,
    };
};
