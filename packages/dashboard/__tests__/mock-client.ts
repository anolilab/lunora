import type {
    AuthPage,
    AuthSession,
    AuthUser,
    CirrusClient,
    FunctionDescriptor,
    FunctionReference,
    GlobalTableInfo,
    GlobalTablePage,
    ScheduleRecord,
    StorageListPage,
} from "@cirrus/client";
import { vi } from "vitest";

export interface MockClientHooks {
    action: ReturnType<typeof vi.fn>;
    asClient: CirrusClient;
    cancelScheduledJob: ReturnType<typeof vi.fn>;
    /** Push a value to every live subscriber registered for `reference`. */
    emit: (reference: string, value: unknown) => void;
    listAuthSessions: ReturnType<typeof vi.fn>;
    listAuthUsers: ReturnType<typeof vi.fn>;
    listFunctions: ReturnType<typeof vi.fn>;
    listGlobalTables: ReturnType<typeof vi.fn>;
    listScheduledJobs: ReturnType<typeof vi.fn>;
    listStorageObjects: ReturnType<typeof vi.fn>;
    mutation: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    readGlobalTablePage: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
}

type Impl = (reference: string, args: unknown, options: unknown) => unknown;

const makeMethod = (impl?: Impl): ReturnType<typeof vi.fn> =>
    vi.fn(async (fn: FunctionReference, args: unknown, options: unknown) => {
        return impl ? impl(fn.__cirrusRef, args, options) : undefined;
    });

export interface MockClientImpls {
    action?: Impl;
    cancelScheduledJob?: (id: string) => { cancelled: boolean };
    listAuthSessions?: (options: { limit?: number; offset?: number; userId?: string }) => AuthPage<AuthSession>;
    listAuthUsers?: (options: { limit?: number; offset?: number }) => AuthPage<AuthUser>;
    listFunctions?: () => FunctionDescriptor[];
    listGlobalTables?: () => GlobalTableInfo[];
    listScheduledJobs?: () => ScheduleRecord[];
    listStorageObjects?: (options: { cursor?: string; limit?: number; prefix?: string }) => StorageListPage;
    mutation?: Impl;
    query?: Impl;
    readGlobalTablePage?: (options: { limit?: number; offset?: number; table: string }) => GlobalTablePage;
}

export const createMockClient = (impls: MockClientImpls = {}): MockClientHooks => {
    const query = makeMethod(impls.query);
    const mutation = makeMethod(impls.mutation);
    const action = makeMethod(impls.action);
    const listFunctions = vi.fn(async () => impls.listFunctions?.() ?? []);
    const listScheduledJobs = vi.fn(async () => impls.listScheduledJobs?.() ?? []);
    const cancelScheduledJob = vi.fn(async (id: string) => impls.cancelScheduledJob?.(id) ?? { cancelled: true });
    const listStorageObjects = vi.fn(
        async (options: { cursor?: string; limit?: number; prefix?: string } = {}) => impls.listStorageObjects?.(options) ?? { objects: [] },
    );
    const listGlobalTables = vi.fn(async () => impls.listGlobalTables?.() ?? []);
    const readGlobalTablePage = vi.fn(
        async (options: { limit?: number; offset?: number; table: string }) => impls.readGlobalTablePage?.(options) ?? { columns: [], rows: [], total: 0 },
    );
    const listAuthUsers = vi.fn(async (options: { limit?: number; offset?: number } = {}) => impls.listAuthUsers?.(options) ?? { rows: [], total: 0 });
    const listAuthSessions = vi.fn(
        async (options: { limit?: number; offset?: number; userId?: string } = {}) => impls.listAuthSessions?.(options) ?? { rows: [], total: 0 },
    );

    // Live-subscription registry: `subscribe` records each callback by
    // functionPath; `emit` fans a value out to those callbacks so panel tests
    // can simulate a server push without a real socket.
    const subscribers = new Map<string, Set<(value: unknown) => void>>();
    const subscribe = vi.fn((fn: FunctionReference, _args: unknown, callback: (value: unknown) => void) => {
        const set = subscribers.get(fn.__cirrusRef) ?? new Set();

        set.add(callback);
        subscribers.set(fn.__cirrusRef, set);

        return () => {
            set.delete(callback);
        };
    });
    const emit = (reference: string, value: unknown): void => {
        for (const callback of subscribers.get(reference) ?? []) {
            callback(value);
        }
    };

    const asClient = {
        action,
        cancelScheduledJob,
        listAuthSessions,
        listAuthUsers,
        listFunctions,
        listGlobalTables,
        listScheduledJobs,
        listStorageObjects,
        mutation,
        query,
        readGlobalTablePage,
        subscribe,
    } as unknown as CirrusClient;

    return {
        action,
        asClient,
        cancelScheduledJob,
        emit,
        listAuthSessions,
        listAuthUsers,
        listFunctions,
        listGlobalTables,
        listScheduledJobs,
        listStorageObjects,
        mutation,
        query,
        readGlobalTablePage,
        subscribe,
    };
};
