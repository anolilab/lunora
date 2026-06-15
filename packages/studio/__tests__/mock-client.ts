import type {
    AuthPage,
    AuthSession,
    AuthUser,
    LunoraClient,
    CronJobInfo,
    FunctionDescriptor,
    FunctionReference,
    GlobalFacetResult,
    GlobalFilterClause,
    GlobalTableInfo,
    GlobalTablePage,
    ScheduleRecord,
    ShardTrafficResult,
    StorageListPage,
    VectorIndexSummary,
    VectorQueryMatch,
} from "@lunora/client";
import { vi } from "vitest";

interface MockClientHooks {
    action: ReturnType<typeof vi.fn>;
    asClient: LunoraClient;
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
    facetGlobalColumn: ReturnType<typeof vi.fn>;
    fetchOpenApi: ReturnType<typeof vi.fn>;
    fetchOpenRpc: ReturnType<typeof vi.fn>;
    getAuthCapabilities: ReturnType<typeof vi.fn>;
    getCronJobs: ReturnType<typeof vi.fn>;
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
    listStorageBuckets: ReturnType<typeof vi.fn>;
    listStorageObjects: ReturnType<typeof vi.fn>;
    listVectorIndexes: ReturnType<typeof vi.fn>;
    mutation: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    queryVectorIndex: ReturnType<typeof vi.fn>;
    readGlobalTablePage: ReturnType<typeof vi.fn>;
    removeAuthOrgMember: ReturnType<typeof vi.fn>;
    removeAuthUser: ReturnType<typeof vi.fn>;
    revokeAuthSession: ReturnType<typeof vi.fn>;
    revokeAuthUserSessions: ReturnType<typeof vi.fn>;
    setAuthUserPassword: ReturnType<typeof vi.fn>; // gitleaks:allow -- mock method name, not a secret
    setAuthUserRole: ReturnType<typeof vi.fn>;
    shardTraffic: ReturnType<typeof vi.fn>;
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
        async (function_: FunctionReference, args: unknown, options: unknown) => (impl ? impl(function_.__lunoraRef, args, options) : undefined),
    );

interface MockClientImpls {
    action?: Impl;
    cancelScheduledJob?: (id: string) => { cancelled: boolean };
    facetGlobalColumn?: (options: { column: string; filters?: GlobalFilterClause[]; limit?: number; table: string }) => GlobalFacetResult;
    fetchOpenApi?: () => Record<string, unknown>;
    fetchOpenRpc?: () => Record<string, unknown>;
    getCronJobs?: () => CronJobInfo[];
    listAuthSessions?: (options: { limit?: number; offset?: number; userId?: string }) => AuthPage<AuthSession>;
    listAuthUsers?: (options: ListAuthUsersOptions) => AuthPage<AuthUser>;
    listFunctions?: () => FunctionDescriptor[];
    listGlobalTables?: () => GlobalTableInfo[];
    listScheduledJobs?: () => ScheduleRecord[];
    listStorageBuckets?: () => string[];
    listStorageObjects?: (options: { bucket?: string; cursor?: string; limit?: number; prefix?: string }) => StorageListPage;
    listVectorIndexes?: () => VectorIndexSummary[];
    mutation?: Impl;
    query?: Impl;
    queryVectorIndex?: (options: { name: string; text: string; topK?: number }) => VectorQueryMatch[];
    readGlobalTablePage?: (options: { filters?: GlobalFilterClause[]; limit?: number; offset?: number; table: string }) => GlobalTablePage;
    shardTraffic?: (table: string) => ShardTrafficResult;
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
    const getCronJobs = vi.fn<() => Promise<CronJobInfo[]>>(async () => impls.getCronJobs?.() ?? []);
    const cancelScheduledJob = vi.fn<(id: string) => Promise<{ cancelled: boolean }>>(
        async (id: string) => impls.cancelScheduledJob?.(id) ?? { cancelled: true },
    );
    const listStorageBuckets = vi.fn<() => Promise<string[]>>(async () => impls.listStorageBuckets?.() ?? []);
    const listStorageObjects = vi.fn<(options?: { bucket?: string; cursor?: string; limit?: number; prefix?: string }) => Promise<StorageListPage>>(
        async (options: { bucket?: string; cursor?: string; limit?: number; prefix?: string } = {}) => impls.listStorageObjects?.(options) ?? { objects: [] },
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
    const shardTraffic = vi.fn<(table: string) => Promise<ShardTrafficResult>>(
        async (table: string) => impls.shardTraffic?.(table) ?? { failed: 0, ok: 0, shards: [] },
    );
    const listGlobalTables = vi.fn<() => Promise<GlobalTableInfo[]>>(async () => impls.listGlobalTables?.() ?? []);
    const listVectorIndexes = vi.fn<() => Promise<VectorIndexSummary[]>>(async () => impls.listVectorIndexes?.() ?? []);
    const queryVectorIndex = vi.fn<(options: { name: string; text: string; topK?: number }) => Promise<VectorQueryMatch[]>>(
        async (options: { name: string; text: string; topK?: number }) => impls.queryVectorIndex?.(options) ?? [],
    );
    const readGlobalTablePage = vi.fn<
        (options: { filters?: GlobalFilterClause[]; limit?: number; offset?: number; table: string }) => Promise<GlobalTablePage>
    >(
        async (options: { filters?: GlobalFilterClause[]; limit?: number; offset?: number; table: string }) =>
            impls.readGlobalTablePage?.(options) ?? { columns: [], rows: [], total: 0 },
    );
    const facetGlobalColumn = vi.fn<(options: { column: string; filters?: GlobalFilterClause[]; limit?: number; table: string }) => Promise<GlobalFacetResult>>(
        async (options: { column: string; filters?: GlobalFilterClause[]; limit?: number; table: string }) =>
            impls.facetGlobalColumn?.(options) ?? { truncated: false, values: [] },
    );
    const listAuthUsers = vi.fn<(options?: ListAuthUsersOptions) => Promise<AuthPage<AuthUser>>>(
        async (options: ListAuthUsersOptions = {}) => impls.listAuthUsers?.(options) ?? { rows: [], total: 0 },
    );
    const listAuthSessions = vi.fn<(options?: { limit?: number; offset?: number; userId?: string }) => Promise<AuthPage<AuthSession>>>(
        async (options: { limit?: number; offset?: number; userId?: string } = {}) => impls.listAuthSessions?.(options) ?? { rows: [], total: 0 },
    );

    // Auth-admin mutations: simple resolved stubs (the dashboard's actions refetch
    // on success, so the returned shape only needs to satisfy the call site).
    const createAuthUser = vi.fn<(input: { email: string; name: string }) => Promise<{ email: string; id: string; name: string }>>(async (input) => {
        return { id: "usr_new", ...input };
    });
    const setAuthUserRole = vi.fn<(input: { role: string; userId: string }) => Promise<{ id: string; role: string }>>(async (input) => {
        return { id: input.userId, role: input.role };
    });
    const banAuthUser = vi.fn<(input: { userId: string }) => Promise<{ banned: boolean; id: string }>>(async (input) => {
        return { banned: true, id: input.userId };
    });
    const unbanAuthUser = vi.fn<(input: { userId: string }) => Promise<{ banned: boolean; id: string }>>(async (input) => {
        return { banned: false, id: input.userId };
    });
    const setAuthUserPassword = vi.fn<() => Promise<undefined>>(async () => undefined);
    const removeAuthUser = vi.fn<() => Promise<undefined>>(async () => undefined);
    const impersonateAuthUser = vi.fn<(input: { userId: string }) => Promise<{ token: string; user: { id: string } }>>(async (input) => {
        return { token: `tok_${input.userId}`, user: { id: input.userId } };
    });
    const revokeAuthSession = vi.fn<() => Promise<undefined>>(async () => undefined);
    const revokeAuthUserSessions = vi.fn<() => Promise<undefined>>(async () => undefined);
    const getAuthCapabilities = vi.fn<() => Promise<{ accounts: boolean; admin: boolean; organization: boolean; passkey: boolean; twoFactor: boolean }>>(
        async () => {
            return { accounts: true, admin: true, organization: false, passkey: false, twoFactor: false };
        },
    );
    const updateAuthUser = vi.fn<(input: { userId: string }) => Promise<{ id: string }>>(async (input) => {
        return { id: input.userId };
    });
    const listAuthAccounts = vi.fn<() => Promise<Record<string, unknown>[]>>(async () => [] as Record<string, unknown>[]);
    const unlinkAuthAccount = vi.fn<() => Promise<undefined>>(async () => undefined);
    const listAuthPasskeys = vi.fn<() => Promise<Record<string, unknown>[]>>(async () => [] as Record<string, unknown>[]);
    const deleteAuthPasskey = vi.fn<() => Promise<undefined>>(async () => undefined);
    const disableAuthTwoFactor = vi.fn<() => Promise<undefined>>(async () => undefined);
    const listAuthOrganizations = vi.fn<() => Promise<{ rows: Record<string, unknown>[]; total: number }>>(async () => {
        return { rows: [] as Record<string, unknown>[], total: 0 };
    });
    const listAuthOrgMembers = vi.fn<() => Promise<{ rows: Record<string, unknown>[]; total: number }>>(async () => {
        return { rows: [] as Record<string, unknown>[], total: 0 };
    });
    const listAuthOrgInvitations = vi.fn<() => Promise<{ rows: Record<string, unknown>[]; total: number }>>(async () => {
        return { rows: [] as Record<string, unknown>[], total: 0 };
    });
    const removeAuthOrgMember = vi.fn<() => Promise<undefined>>(async () => undefined);
    const cancelAuthOrgInvitation = vi.fn<() => Promise<undefined>>(async () => undefined);

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
        const set = subscribers.get(function_.__lunoraRef) ?? new Set<Sub>();
        const sub: Sub = { onError: options?.onError, onValue: callback };

        set.add(sub);
        subscribers.set(function_.__lunoraRef, set);

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
        setAuthUserPassword, // gitleaks:allow -- mock method name, not a secret
        setAuthUserRole,
        unbanAuthUser,
        unlinkAuthAccount,
        updateAuthUser,
    };

    const asClient = {
        action,
        cancelScheduledJob,
        deleteStorageObject,
        facetGlobalColumn,
        fetchOpenApi,
        fetchOpenRpc,
        getCronJobs,
        listAuthSessions,
        listAuthUsers,
        listFunctions,
        listGlobalTables,
        listScheduledJobs,
        listStorageBuckets,
        listStorageObjects,
        listVectorIndexes,
        mutation,
        query,
        queryVectorIndex,
        readGlobalTablePage,
        shardTraffic,
        signedStorageUrl,
        subscribe,
        subscribeScheduledJobs,
        uploadStorageObject,
        ...authAdminMethods,
    } as unknown as LunoraClient;

    return {
        action,
        asClient,
        cancelScheduledJob,
        deleteStorageObject,
        emit,
        emitError,
        emitJobs,
        facetGlobalColumn,
        fetchOpenApi,
        fetchOpenRpc,
        getCronJobs,
        listAuthSessions,
        listAuthUsers,
        listFunctions,
        listGlobalTables,
        listScheduledJobs,
        listStorageBuckets,
        listStorageObjects,
        listVectorIndexes,
        mutation,
        query,
        queryVectorIndex,
        readGlobalTablePage,
        shardTraffic,
        signedStorageUrl,
        subscribe,
        subscribeScheduledJobs,
        uploadStorageObject,
        ...authAdminMethods,
    };
};

export type { MockClientHooks, MockClientImpls };
