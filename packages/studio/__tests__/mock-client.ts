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
    banAuthUser: ReturnType<typeof vi.fn>;
    cancelAuthOrgInvitation: ReturnType<typeof vi.fn>;
    cancelScheduledJob: ReturnType<typeof vi.fn>;
    createAuthUser: ReturnType<typeof vi.fn>;
    deleteAuthPasskey: ReturnType<typeof vi.fn>;
    deleteStorageObject: ReturnType<typeof vi.fn>;
    disableAuthTwoFactor: ReturnType<typeof vi.fn>;
    /** Push a value to every live subscriber registered for `reference`. */
    emit: (reference: string, value: unknown) => void;
    /** Push a subscription error to every live subscriber registered for `reference`. */
    emitError: (reference: string, message: string) => void;
    /** Push a job list to every live `subscribeScheduledJobs` subscriber. */
    emitJobs: (jobs: ScheduleRecord[]) => void;
    fetchOpenApi: ReturnType<typeof vi.fn>;
    fetchOpenRpc: ReturnType<typeof vi.fn>;
    getAuthCapabilities: ReturnType<typeof vi.fn>;
    impersonateAuthUser: ReturnType<typeof vi.fn>;
    listAuthAccounts: ReturnType<typeof vi.fn>;
    listAuthOrganizations: ReturnType<typeof vi.fn>;
    listAuthOrgInvitations: ReturnType<typeof vi.fn>;
    listAuthOrgMembers: ReturnType<typeof vi.fn>;
    listAuthPasskeys: ReturnType<typeof vi.fn>;
    listAuthSessions: ReturnType<typeof vi.fn>;
    listAuthUsers: ReturnType<typeof vi.fn>;
    listFunctions: ReturnType<typeof vi.fn>;
    listGlobalTables: ReturnType<typeof vi.fn>;
    listScheduledJobs: ReturnType<typeof vi.fn>;
    listStorageObjects: ReturnType<typeof vi.fn>;
    mutation: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    readGlobalTablePage: ReturnType<typeof vi.fn>;
    removeAuthOrgMember: ReturnType<typeof vi.fn>;
    removeAuthUser: ReturnType<typeof vi.fn>;
    revokeAuthSession: ReturnType<typeof vi.fn>;
    revokeAuthUserSessions: ReturnType<typeof vi.fn>;
    setAuthUserPassword: ReturnType<typeof vi.fn>;
    setAuthUserRole: ReturnType<typeof vi.fn>;
    signedStorageUrl: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    subscribeScheduledJobs: ReturnType<typeof vi.fn>;
    unbanAuthUser: ReturnType<typeof vi.fn>;
    unlinkAuthAccount: ReturnType<typeof vi.fn>;
    updateAuthUser: ReturnType<typeof vi.fn>;
    uploadStorageObject: ReturnType<typeof vi.fn>;
}

interface ListAuthUsersOptions {
    filterField?: string;
    filterValue?: string;
    limit?: number;
    offset?: number;
    search?: string;
    searchField?: string;
    sortBy?: string;
    sortDirection?: "asc" | "desc";
}

type Impl = (reference: string, args: unknown, options: unknown) => unknown;

const makeMethod = (impl?: Impl): ReturnType<typeof vi.fn> =>
    vi.fn<(function_: FunctionReference, args: unknown, options: unknown) => Promise<unknown>>(
        async (function_: FunctionReference, args: unknown, options: unknown) => (impl ? impl(function_.__cirrusRef, args, options) : undefined),
    );

interface MockClientImpls {
    action?: Impl;
    cancelScheduledJob?: (id: string) => { cancelled: boolean };
    fetchOpenApi?: () => Record<string, unknown>;
    fetchOpenRpc?: () => Record<string, unknown>;
    listAuthSessions?: (options: { limit?: number; offset?: number; userId?: string }) => AuthPage<AuthSession>;
    listAuthUsers?: (options: ListAuthUsersOptions) => AuthPage<AuthUser>;
    listFunctions?: () => FunctionDescriptor[];
    listGlobalTables?: () => GlobalTableInfo[];
    listScheduledJobs?: () => ScheduleRecord[];
    listStorageObjects?: (options: { cursor?: string; limit?: number; prefix?: string }) => StorageListPage;
    mutation?: Impl;
    query?: Impl;
    readGlobalTablePage?: (options: { limit?: number; offset?: number; table: string }) => GlobalTablePage;
    signedStorageUrl?: (key: string) => string;
}

export const createMockClient = (impls: MockClientImpls = {}): MockClientHooks => {
    const query = makeMethod(impls.query);
    const mutation = makeMethod(impls.mutation);
    const action = makeMethod(impls.action);
    const listFunctions = vi.fn<() => Promise<FunctionDescriptor[]>>(async () => impls.listFunctions?.() ?? []);
    const fetchOpenApi = vi.fn<() => Promise<Record<string, unknown>>>(async () => impls.fetchOpenApi?.() ?? { openapi: "3.1.0", paths: {} });
    const fetchOpenRpc = vi.fn<() => Promise<Record<string, unknown>>>(async () => impls.fetchOpenRpc?.() ?? { methods: [], openrpc: "1.3.2" });
    const listScheduledJobs = vi.fn<() => Promise<ScheduleRecord[]>>(async () => impls.listScheduledJobs?.() ?? []);
    const cancelScheduledJob = vi.fn<(id: string) => Promise<{ cancelled: boolean }>>(
        async (id: string) => impls.cancelScheduledJob?.(id) ?? { cancelled: true },
    );
    const listStorageObjects = vi.fn<(options?: { cursor?: string; limit?: number; prefix?: string }) => Promise<StorageListPage>>(
        async (options: { cursor?: string; limit?: number; prefix?: string } = {}) => impls.listStorageObjects?.(options) ?? { objects: [] },
    );
    const deleteStorageObject = vi.fn<(key: string) => Promise<{ deleted: boolean; key: string }>>(async (key: string) => {
        return { deleted: true, key };
    });
    const uploadStorageObject = vi.fn<(options: { body: ArrayBuffer | Blob; contentType?: string; key: string }) => Promise<{ etag?: string; key: string }>>(
        async (options: { body: ArrayBuffer | Blob; contentType?: string; key: string }) => {
            return { etag: "mock-etag", key: options.key };
        },
    );
    const signedStorageUrl = vi.fn<(key: string) => Promise<string>>(
        async (key: string) => impls.signedStorageUrl?.(key) ?? `https://mock.example/${key}?sig=test`,
    );
    const listGlobalTables = vi.fn<() => Promise<GlobalTableInfo[]>>(async () => impls.listGlobalTables?.() ?? []);
    const readGlobalTablePage = vi.fn<(options: { limit?: number; offset?: number; table: string }) => Promise<GlobalTablePage>>(
        async (options: { limit?: number; offset?: number; table: string }) => impls.readGlobalTablePage?.(options) ?? { columns: [], rows: [], total: 0 },
    );
    const listAuthUsers = vi.fn<(options?: ListAuthUsersOptions) => Promise<AuthPage<AuthUser>>>(
        async (options: ListAuthUsersOptions = {}) => impls.listAuthUsers?.(options) ?? { rows: [], total: 0 },
    );
    const listAuthSessions = vi.fn<(options?: { limit?: number; offset?: number; userId?: string }) => Promise<AuthPage<AuthSession>>>(
        async (options: { limit?: number; offset?: number; userId?: string } = {}) => impls.listAuthSessions?.(options) ?? { rows: [], total: 0 },
    );

    // Auth-admin mutations: simple resolved stubs (the dashboard's actions refetch
    // on success, so the returned shape only needs to satisfy the call site).
    const createAuthUser = vi.fn(async (input: { email: string; name: string }) => {
        return { id: "usr_new", ...input };
    });
    const setAuthUserRole = vi.fn(async (input: { role: string; userId: string }) => {
        return { id: input.userId, role: input.role };
    });
    const banAuthUser = vi.fn(async (input: { userId: string }) => {
        return { banned: true, id: input.userId };
    });
    const unbanAuthUser = vi.fn(async (input: { userId: string }) => {
        return { banned: false, id: input.userId };
    });
    const setAuthUserPassword = vi.fn(async () => undefined);
    const removeAuthUser = vi.fn(async () => undefined);
    const impersonateAuthUser = vi.fn(async (input: { userId: string }) => {
        return { token: `tok_${input.userId}`, user: { id: input.userId } };
    });
    const revokeAuthSession = vi.fn(async () => undefined);
    const revokeAuthUserSessions = vi.fn(async () => undefined);
    const getAuthCapabilities = vi.fn(async () => {
        return { accounts: true, admin: true, organization: false, passkey: false, twoFactor: false };
    });
    const updateAuthUser = vi.fn(async (input: { userId: string }) => {
        return { id: input.userId };
    });
    const listAuthAccounts = vi.fn(async () => [] as Record<string, unknown>[]);
    const unlinkAuthAccount = vi.fn(async () => undefined);
    const listAuthPasskeys = vi.fn(async () => [] as Record<string, unknown>[]);
    const deleteAuthPasskey = vi.fn(async () => undefined);
    const disableAuthTwoFactor = vi.fn(async () => undefined);
    const listAuthOrganizations = vi.fn(async () => {
        return { rows: [] as Record<string, unknown>[], total: 0 };
    });
    const listAuthOrgMembers = vi.fn(async () => {
        return { rows: [] as Record<string, unknown>[], total: 0 };
    });
    const listAuthOrgInvitations = vi.fn(async () => {
        return { rows: [] as Record<string, unknown>[], total: 0 };
    });
    const removeAuthOrgMember = vi.fn(async () => undefined);
    const cancelAuthOrgInvitation = vi.fn(async () => undefined);

    // Live-subscription registry: `subscribe` records each value + error
    // callback by functionPath; `emit` / `emitError` fan out to those callbacks
    // so panel tests can simulate a server push or rejection without a socket.
    interface Sub {
        onError?: (error: { message: string }) => void;
        onValue: (value: unknown) => void;
    }
    const subscribers = new Map<string, Set<Sub>>();
    const subscribe = vi.fn<
        (
            function_: FunctionReference,
            args: unknown,
            callback: (value: unknown) => void,
            options?: { onError?: (error: { message: string }) => void },
        ) => () => void
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

    const authAdminMethods = {
        banAuthUser,
        cancelAuthOrgInvitation,
        createAuthUser,
        deleteAuthPasskey,
        disableAuthTwoFactor,
        getAuthCapabilities,
        impersonateAuthUser,
        listAuthAccounts,
        listAuthOrgInvitations,
        listAuthOrgMembers,
        listAuthOrganizations,
        listAuthPasskeys,
        removeAuthOrgMember,
        removeAuthUser,
        revokeAuthSession,
        revokeAuthUserSessions,
        setAuthUserPassword,
        setAuthUserRole,
        unbanAuthUser,
        unlinkAuthAccount,
        updateAuthUser,
    };

    const asClient = {
        action,
        cancelScheduledJob,
        deleteStorageObject,
        fetchOpenApi,
        fetchOpenRpc,
        listAuthSessions,
        listAuthUsers,
        listFunctions,
        listGlobalTables,
        listScheduledJobs,
        listStorageObjects,
        mutation,
        query,
        readGlobalTablePage,
        signedStorageUrl,
        subscribe,
        subscribeScheduledJobs,
        uploadStorageObject,
        ...authAdminMethods,
    } as unknown as CirrusClient;

    return {
        action,
        asClient,
        cancelScheduledJob,
        deleteStorageObject,
        emit,
        emitError,
        emitJobs,
        fetchOpenApi,
        fetchOpenRpc,
        listAuthSessions,
        listAuthUsers,
        listFunctions,
        listGlobalTables,
        listScheduledJobs,
        listStorageObjects,
        mutation,
        query,
        readGlobalTablePage,
        signedStorageUrl,
        subscribe,
        subscribeScheduledJobs,
        uploadStorageObject,
        ...authAdminMethods,
    };
};

export type { MockClientHooks, MockClientImpls };
