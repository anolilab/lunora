import type {
    AuthPage,
    AuthSession,
    AuthUser,
    CronJobInfo,
    FunctionDescriptor,
    FunctionReference,
    GlobalFacetResult,
    GlobalFilterClause,
    GlobalTableInfo,
    GlobalTablePage,
    KvKeyListResult,
    KvNamespaceSummary,
    KvValueResult,
    LunoraClient,
    PipelineLogPage,
    PipelineLogQuery,
    ScheduleRecord,
    ShardTrafficResult,
    StorageListPage,
    VectorIndexSummary,
    VectorQueryMatch,
} from "@lunora/client";
import { vi } from "vitest";

interface MockClientHooks {
    action: ReturnType<typeof vi.fn>;
    addAuthOrgMember: ReturnType<typeof vi.fn>;
    addAuthOrgTeamMember: ReturnType<typeof vi.fn>;
    asClient: LunoraClient;
    banAuthUser: ReturnType<typeof vi.fn>;
    cancelAuthOrgInvitation: ReturnType<typeof vi.fn>;
    cancelScheduledJob: ReturnType<typeof vi.fn>;
    createAuthOrganization: ReturnType<typeof vi.fn>;
    createAuthOrgRole: ReturnType<typeof vi.fn>;
    createAuthOrgTeam: ReturnType<typeof vi.fn>;
    createAuthSignUpInvitation: ReturnType<typeof vi.fn>;
    createAuthUser: ReturnType<typeof vi.fn>;
    deleteAuthOrganization: ReturnType<typeof vi.fn>;
    deleteAuthOrgRole: ReturnType<typeof vi.fn>;
    deleteAuthPasskey: ReturnType<typeof vi.fn>;
    deleteKvKey: ReturnType<typeof vi.fn>;
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
    getAuthConfig: ReturnType<typeof vi.fn>;
    getCronJobs: ReturnType<typeof vi.fn>;
    getKvValue: ReturnType<typeof vi.fn>;
    impersonateAuthUser: ReturnType<typeof vi.fn>;
    inviteAuthOrgMember: ReturnType<typeof vi.fn>;
    listAuthAccounts: ReturnType<typeof vi.fn>;
    listAuthOrganizations: ReturnType<typeof vi.fn>;
    listAuthOrgInvitations: ReturnType<typeof vi.fn>;
    listAuthOrgMembers: ReturnType<typeof vi.fn>;
    listAuthOrgRoles: ReturnType<typeof vi.fn>;
    listAuthOrgTeamMembers: ReturnType<typeof vi.fn>;
    listAuthOrgTeams: ReturnType<typeof vi.fn>;
    listAuthPasskeys: ReturnType<typeof vi.fn>;
    listAuthSessions: ReturnType<typeof vi.fn>;
    listAuthSignUpInvitations: ReturnType<typeof vi.fn>;
    listAuthUsers: ReturnType<typeof vi.fn>;
    listFunctions: ReturnType<typeof vi.fn>;
    listGlobalTables: ReturnType<typeof vi.fn>;
    listKvKeys: ReturnType<typeof vi.fn>;
    listKvNamespaces: ReturnType<typeof vi.fn>;
    listScheduledJobs: ReturnType<typeof vi.fn>;
    listStorageBuckets: ReturnType<typeof vi.fn>;
    listStorageObjects: ReturnType<typeof vi.fn>;
    listVectorIndexes: ReturnType<typeof vi.fn>;
    mutation: ReturnType<typeof vi.fn>;
    putKvValue: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    queryLogArchive: ReturnType<typeof vi.fn>;
    queryVectorIndex: ReturnType<typeof vi.fn>;
    readGlobalTablePage: ReturnType<typeof vi.fn>;
    removeAuthOrgMember: ReturnType<typeof vi.fn>;
    removeAuthOrgTeam: ReturnType<typeof vi.fn>;
    removeAuthOrgTeamMember: ReturnType<typeof vi.fn>;
    removeAuthUser: ReturnType<typeof vi.fn>;
    revokeAuthSession: ReturnType<typeof vi.fn>;
    revokeAuthSignUpInvitation: ReturnType<typeof vi.fn>;
    revokeAuthUserSessions: ReturnType<typeof vi.fn>;
    runCronJob: ReturnType<typeof vi.fn>;
    setAuthOrgMemberRole: ReturnType<typeof vi.fn>;
    setAuthUserPassword: ReturnType<typeof vi.fn>; // gitleaks:allow -- mock method name, not a secret
    setAuthUserRole: ReturnType<typeof vi.fn>;
    shardTraffic: ReturnType<typeof vi.fn>;
    signedStorageUrl: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    subscribeScheduledJobs: ReturnType<typeof vi.fn>;
    unbanAuthUser: ReturnType<typeof vi.fn>;
    unlinkAuthAccount: ReturnType<typeof vi.fn>;
    updateAuthOrganization: ReturnType<typeof vi.fn>;
    updateAuthOrgRole: ReturnType<typeof vi.fn>;
    updateAuthOrgTeam: ReturnType<typeof vi.fn>;
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
    /** The KV namespaces the browser lists. Defaults to `[]`. */
    kvNamespaces?: KvNamespaceSummary[];
    /** Seed entries per namespace binding → key → stored entry. Mutated in place by put/delete. */
    kvSeed?: Record<string, Record<string, { expiration?: number; metadata?: unknown; value: string }>>;
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
    queryLogArchive?: (query?: PipelineLogQuery) => PipelineLogPage;
    queryVectorIndex?: (options: { name: string; text: string; topK?: number }) => VectorQueryMatch[];
    readGlobalTablePage?: (options: { filters?: GlobalFilterClause[]; limit?: number; offset?: number; table: string }) => GlobalTablePage;
    runCronJob?: (name: string) => { name: string; ran: boolean };
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
    const runCronJob = vi.fn<(name: string) => Promise<{ name: string; ran: boolean }>>(
        async (name: string) => impls.runCronJob?.(name) ?? { name, ran: true },
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

    // In-memory KV store, seeded from `impls.kvSeed` and mutated in place by
    // put/delete so create → list → edit → delete round-trips the way the real
    // introspector does.
    const kvStore: Record<string, Record<string, { expiration?: number; metadata?: unknown; value: string }>> = impls.kvSeed ?? {};
    const listKvNamespaces = vi.fn<() => Promise<KvNamespaceSummary[]>>(async () => impls.kvNamespaces ?? []);
    const listKvKeys = vi.fn<(options: { cursor?: string; limit?: number; namespace: string; prefix?: string }) => Promise<KvKeyListResult>>(
        async (options: { cursor?: string; limit?: number; namespace: string; prefix?: string }) => {
            const entries = kvStore[options.namespace] ?? {};
            const keys = Object.keys(entries)
                .filter((name) => (options.prefix === undefined ? true : name.startsWith(options.prefix)))
                .toSorted((a, b) => a.localeCompare(b))
                .map((name) => {
                    return { expiration: entries[name]?.expiration, metadata: entries[name]?.metadata, name };
                });

            return { keys, listComplete: true };
        },
    );
    const getKvValue = vi.fn<(options: { key: string; namespace: string }) => Promise<KvValueResult>>(async (options: { key: string; namespace: string }) => {
        const entry = kvStore[options.namespace]?.[options.key];

        return { metadata: entry?.metadata ?? null, value: entry?.value ?? null };
    });
    const putKvValue = vi.fn<
        (options: { expiration?: number; expirationTtl?: number; key: string; metadata?: unknown; namespace: string; value: string }) => Promise<void>
    >(async (options: { expiration?: number; expirationTtl?: number; key: string; metadata?: unknown; namespace: string; value: string }) => {
        const bucket = kvStore[options.namespace] ?? {};

        kvStore[options.namespace] = bucket;
        bucket[options.key] = { expiration: options.expiration, metadata: options.metadata, value: options.value };
    });
    const deleteKvKey = vi.fn<(options: { key: string; namespace: string }) => Promise<void>>(async (options: { key: string; namespace: string }) => {
        delete kvStore[options.namespace]?.[options.key];
    });

    const listVectorIndexes = vi.fn<() => Promise<VectorIndexSummary[]>>(async () => impls.listVectorIndexes?.() ?? []);
    const queryVectorIndex = vi.fn<(options: { name: string; text: string; topK?: number }) => Promise<VectorQueryMatch[]>>(
        async (options: { name: string; text: string; topK?: number }) => impls.queryVectorIndex?.(options) ?? [],
    );
    const queryLogArchive = vi.fn<(logQuery?: PipelineLogQuery) => Promise<PipelineLogPage>>(
        async (logQuery?: PipelineLogQuery) => impls.queryLogArchive?.(logQuery) ?? { rows: [] },
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
    const listAuthSignUpInvitations = vi.fn<() => Promise<{ rows: Record<string, unknown>[]; total: number }>>(async () => {
        return { rows: [] as Record<string, unknown>[], total: 0 };
    });
    const createAuthSignUpInvitation = vi.fn<() => Promise<Record<string, unknown>>>(async () => {
        return {};
    });
    const revokeAuthSignUpInvitation = vi.fn<() => Promise<undefined>>(async () => undefined);
    const removeAuthOrgMember = vi.fn<() => Promise<undefined>>(async () => undefined);
    const cancelAuthOrgInvitation = vi.fn<() => Promise<undefined>>(async () => undefined);
    const getAuthConfig = vi.fn<() => Promise<Record<string, unknown>>>(async () => {
        return {
            capabilities: { accounts: true, admin: true, inviteOnly: false, organization: false, passkey: false, twoFactor: false },
            emailAndPassword: true,
            organization: { enabled: false, roles: false, teams: false },
            plugins: [] as string[],
            rateLimit: { enabled: false },
            session: {},
            socialProviders: [] as string[],
            userFields: [] as Record<string, unknown>[],
        };
    });
    const createAuthOrganization = vi.fn<(input: Record<string, unknown>) => Promise<Record<string, unknown>>>(async (input) => {
        return { id: "org_new", ...input };
    });
    const updateAuthOrganization = vi.fn<(input: { organizationId: string }) => Promise<Record<string, unknown>>>(async (input) => {
        return { id: input.organizationId };
    });
    const deleteAuthOrganization = vi.fn<() => Promise<undefined>>(async () => undefined);
    const addAuthOrgMember = vi.fn<(input: { userId: string }) => Promise<Record<string, unknown>>>(async (input) => {
        return { id: "mem_new", userId: input.userId };
    });
    const inviteAuthOrgMember = vi.fn<(input: { email: string }) => Promise<Record<string, unknown>>>(async (input) => {
        return { email: input.email, id: "inv_new" };
    });
    const setAuthOrgMemberRole = vi.fn<(input: { memberId: string; role: string | string[] }) => Promise<Record<string, unknown>>>(async (input) => {
        return {
            id: input.memberId,
            role: input.role,
        };
    });
    const listAuthOrgTeams = vi.fn<() => Promise<{ rows: Record<string, unknown>[]; total: number }>>(async () => {
        return { rows: [] as Record<string, unknown>[], total: 0 };
    });
    const createAuthOrgTeam = vi.fn<(input: { name: string }) => Promise<Record<string, unknown>>>(async (input) => {
        return { id: "team_new", name: input.name };
    });
    const updateAuthOrgTeam = vi.fn<(input: { name: string; teamId: string }) => Promise<Record<string, unknown>>>(async (input) => {
        return {
            id: input.teamId,
            name: input.name,
        };
    });
    const removeAuthOrgTeam = vi.fn<() => Promise<undefined>>(async () => undefined);
    const listAuthOrgTeamMembers = vi.fn<() => Promise<{ rows: Record<string, unknown>[]; total: number }>>(async () => {
        return { rows: [] as Record<string, unknown>[], total: 0 };
    });
    const addAuthOrgTeamMember = vi.fn<(input: { teamId: string; userId: string }) => Promise<Record<string, unknown>>>(async (input) => {
        return {
            id: "tm_new",
            teamId: input.teamId,
            userId: input.userId,
        };
    });
    const removeAuthOrgTeamMember = vi.fn<() => Promise<undefined>>(async () => undefined);
    const listAuthOrgRoles = vi.fn<() => Promise<{ rows: Record<string, unknown>[]; total: number }>>(async () => {
        return { rows: [] as Record<string, unknown>[], total: 0 };
    });
    const createAuthOrgRole = vi.fn<(input: { role: string }) => Promise<Record<string, unknown>>>(async (input) => {
        return { id: "role_new", role: input.role };
    });
    const updateAuthOrgRole = vi.fn<(input: { roleId: string }) => Promise<Record<string, unknown>>>(async (input) => {
        return { id: input.roleId };
    });
    const deleteAuthOrgRole = vi.fn<() => Promise<undefined>>(async () => undefined);

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
        addAuthOrgMember,
        addAuthOrgTeamMember,
        banAuthUser,
        cancelAuthOrgInvitation,
        createAuthOrganization,
        createAuthOrgRole,
        createAuthOrgTeam,
        createAuthUser,
        deleteAuthOrganization,
        deleteAuthOrgRole,
        deleteAuthPasskey,
        disableAuthTwoFactor,
        getAuthCapabilities,
        getAuthConfig,
        impersonateAuthUser,
        inviteAuthOrgMember,
        listAuthAccounts,
        createAuthSignUpInvitation,
        listAuthOrgInvitations,
        listAuthSignUpInvitations,
        revokeAuthSignUpInvitation,
        listAuthOrgMembers,
        listAuthOrgRoles,
        listAuthOrgTeamMembers,
        listAuthOrgTeams,
        listAuthOrganizations,
        listAuthPasskeys,
        removeAuthOrgMember,
        removeAuthOrgTeam,
        removeAuthOrgTeamMember,
        setAuthOrgMemberRole,
        updateAuthOrganization,
        updateAuthOrgRole,
        updateAuthOrgTeam,
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
        // The header's ConnectionBadge reads live socket status via these; the
        // mock has no socket, so it reports a stable "idle" and never notifies.
        connectionStatus: () => "idle" as const,
        onConnectionStatus: (_listener: () => void) => () => {},
        // Stable per-instance id. The deployment-health panel puts it in its query
        // key so a rebuilt client (admin-token change) re-keys instead of serving
        // the previous client's cached result; a mock is one instance per test, so
        // a constant keeps that key stable across renders.
        clientIdentifier: () => "mock-client",
        deleteKvKey,
        // The API try-it console reads both when it dispatches a plain REST
        // route: `url` is the worker origin the request is resolved against, and
        // `getAuthToken` supplies the admin bearer. Stable, non-empty values so a
        // test asserts on what the console actually forwards.
        getAuthToken: () => "mock-admin-token",
        deleteStorageObject,
        facetGlobalColumn,
        fetchOpenApi,
        fetchOpenRpc,
        getCronJobs,
        getKvValue,
        listAuthSessions,
        listAuthUsers,
        listFunctions,
        listGlobalTables,
        listKvKeys,
        listKvNamespaces,
        listScheduledJobs,
        listStorageBuckets,
        listStorageObjects,
        listVectorIndexes,
        mutation,
        putKvValue,
        query,
        queryLogArchive,
        queryVectorIndex,
        readGlobalTablePage,
        runCronJob,
        shardTraffic,
        signedStorageUrl,
        subscribe,
        subscribeScheduledJobs,
        uploadStorageObject,
        /** The worker origin a REST try-it request is resolved against. */
        url: "http://127.0.0.1:8787",
        ...authAdminMethods,
    } as unknown as LunoraClient;

    return {
        action,
        asClient,
        cancelScheduledJob,
        deleteKvKey,
        deleteStorageObject,
        emit,
        emitError,
        emitJobs,
        facetGlobalColumn,
        fetchOpenApi,
        fetchOpenRpc,
        getCronJobs,
        getKvValue,
        listAuthSessions,
        listAuthUsers,
        listFunctions,
        listGlobalTables,
        listKvKeys,
        listKvNamespaces,
        listScheduledJobs,
        listStorageBuckets,
        listStorageObjects,
        listVectorIndexes,
        mutation,
        putKvValue,
        query,
        queryLogArchive,
        queryVectorIndex,
        readGlobalTablePage,
        runCronJob,
        shardTraffic,
        signedStorageUrl,
        subscribe,
        subscribeScheduledJobs,
        uploadStorageObject,
        ...authAdminMethods,
    };
};

export type { MockClientHooks, MockClientImpls };
