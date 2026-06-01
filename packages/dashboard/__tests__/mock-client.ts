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

interface MockClientHooks {
    action: ReturnType<typeof vi.fn>;
    asClient: CirrusClient;
    cancelScheduledJob: ReturnType<typeof vi.fn>;
    /** Push a value to every live subscriber registered for `reference`. */
    emit: (reference: string, value: unknown) => void;
    /** Push a subscription error to every live subscriber registered for `reference`. */
    emitError: (reference: string, message: string) => void;
    /** Push a job list to every live `subscribeScheduledJobs` subscriber. */
    emitJobs: (jobs: ScheduleRecord[]) => void;
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
    subscribeScheduledJobs: ReturnType<typeof vi.fn>;
}

type Impl = (reference: string, args: unknown, options: unknown) => unknown;

const makeMethod = (impl?: Impl): ReturnType<typeof vi.fn> =>
    vi.fn<(function_: FunctionReference, args: unknown, options: unknown) => Promise<unknown>>(async (function_: FunctionReference, args: unknown, options: unknown) =>
        (impl ? impl(function_.__cirrusRef, args, options) : undefined),
    );

interface MockClientImpls {
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
    const listFunctions = vi.fn<() => Promise<FunctionDescriptor[]>>(async () => impls.listFunctions?.() ?? []);
    const listScheduledJobs = vi.fn<() => Promise<ScheduleRecord[]>>(async () => impls.listScheduledJobs?.() ?? []);
    const cancelScheduledJob = vi.fn<(id: string) => Promise<{ cancelled: boolean }>>(
        async (id: string) => impls.cancelScheduledJob?.(id) ?? { cancelled: true },
    );
    const listStorageObjects = vi.fn<(options?: { cursor?: string; limit?: number; prefix?: string }) => Promise<StorageListPage>>(
        async (options: { cursor?: string; limit?: number; prefix?: string } = {}) => impls.listStorageObjects?.(options) ?? { objects: [] },
    );
    const listGlobalTables = vi.fn<() => Promise<GlobalTableInfo[]>>(async () => impls.listGlobalTables?.() ?? []);
    const readGlobalTablePage = vi.fn<(options: { limit?: number; offset?: number; table: string }) => Promise<GlobalTablePage>>(
        async (options: { limit?: number; offset?: number; table: string }) => impls.readGlobalTablePage?.(options) ?? { columns: [], rows: [], total: 0 },
    );
    const listAuthUsers = vi.fn<(options?: { limit?: number; offset?: number }) => Promise<AuthPage<AuthUser>>>(
        async (options: { limit?: number; offset?: number } = {}) => impls.listAuthUsers?.(options) ?? { rows: [], total: 0 },
    );
    const listAuthSessions = vi.fn<(options?: { limit?: number; offset?: number; userId?: string }) => Promise<AuthPage<AuthSession>>>(
        async (options: { limit?: number; offset?: number; userId?: string } = {}) => impls.listAuthSessions?.(options) ?? { rows: [], total: 0 },
    );

    // Live-subscription registry: `subscribe` records each value + error
    // callback by functionPath; `emit` / `emitError` fan out to those callbacks
    // so panel tests can simulate a server push or rejection without a socket.
    interface Sub {
        onError?: (error: { message: string }) => void;
        onValue: (value: unknown) => void;
    }
    const subscribers = new Map<string, Set<Sub>>();
    const subscribe = vi.fn<
        (function_: FunctionReference, args: unknown, callback: (value: unknown) => void, options?: { onError?: (error: { message: string }) => void }) => () => void
    >((function_: FunctionReference, _args: unknown, callback: (value: unknown) => void, options?: { onError?: (error: { message: string }) => void }) => {
        const set = subscribers.get(function_.__cirrusRef) ?? new Set<Sub>();
        const sub: Sub = { onError: options?.onError, onValue: callback };

        set.add(sub);
        subscribers.set(function_.__cirrusRef, set);

        return () => {
            set.delete(sub);
        };
    });
    const emit = (reference: string, value: unknown): void => {
        for (const sub of subscribers.get(reference) ?? []) {
            sub.onValue(value);
        }
    };
    const emitError = (reference: string, message: string): void => {
        for (const sub of subscribers.get(reference) ?? []) {
            sub.onError?.({ message });
        }
    };

    // Live scheduled-jobs WS subscription: records callbacks; `emitJobs` pushes.
    const jobsCallbacks = new Set<(jobs: ScheduleRecord[]) => void>();
    const subscribeScheduledJobs = vi.fn<(onJobs: (jobs: ScheduleRecord[]) => void) => () => void>((onJobs: (jobs: ScheduleRecord[]) => void) => {
        jobsCallbacks.add(onJobs);

        return () => {
            jobsCallbacks.delete(onJobs);
        };
    });
    const emitJobs = (jobs: ScheduleRecord[]): void => {
        for (const callback of jobsCallbacks) {
            callback(jobs);
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
        subscribeScheduledJobs,
    } as unknown as CirrusClient;

    return {
        action,
        asClient,
        cancelScheduledJob,
        emit,
        emitError,
        emitJobs,
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
        subscribeScheduledJobs,
    };
};

export type { MockClientHooks, MockClientImpls };
