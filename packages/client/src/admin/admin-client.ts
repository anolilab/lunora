import {
    AUTH_ACCOUNTS_PATH,
    AUTH_ADD_MEMBER_PATH,
    AUTH_ADD_TEAM_MEMBER_PATH,
    AUTH_BAN_PATH,
    AUTH_CANCEL_INVITATION_PATH,
    AUTH_CAPABILITIES_PATH,
    AUTH_CONFIG_PATH,
    AUTH_CREATE_ORG_PATH,
    AUTH_CREATE_ROLE_PATH,
    AUTH_CREATE_SIGN_UP_INVITATION_PATH,
    AUTH_CREATE_TEAM_PATH,
    AUTH_CREATE_USER_PATH,
    AUTH_DELETE_PASSKEY_PATH,
    AUTH_DISABLE_2FA_PATH,
    AUTH_IMPERSONATE_PATH,
    AUTH_INVITE_MEMBER_PATH,
    AUTH_MEMBER_ROLE_PATH,
    AUTH_ORG_INVITATIONS_PATH,
    AUTH_ORG_MEMBERS_PATH,
    AUTH_ORG_ROLES_PATH,
    AUTH_ORG_TEAM_MEMBERS_PATH,
    AUTH_ORG_TEAMS_PATH,
    AUTH_ORGS_PATH,
    AUTH_PASSKEYS_PATH,
    AUTH_REMOVE_MEMBER_PATH,
    AUTH_REMOVE_ORG_PATH,
    AUTH_REMOVE_ROLE_PATH,
    AUTH_REMOVE_TEAM_MEMBER_PATH,
    AUTH_REMOVE_TEAM_PATH,
    AUTH_REMOVE_USER_PATH,
    AUTH_REVOKE_SESSION_PATH,
    AUTH_REVOKE_SESSIONS_PATH,
    AUTH_REVOKE_SIGN_UP_INVITATION_PATH,
    AUTH_SESSIONS_PATH,
    AUTH_SET_PASSWORD_PATH,
    AUTH_SET_ROLE_PATH,
    AUTH_SIGN_UP_INVITATIONS_PATH,
    AUTH_UNBAN_PATH,
    AUTH_UNLINK_ACCOUNT_PATH,
    AUTH_UPDATE_ORG_PATH,
    AUTH_UPDATE_ROLE_PATH,
    AUTH_UPDATE_TEAM_PATH,
    AUTH_UPDATE_USER_PATH,
    AUTH_USERS_PATH,
} from "../client-paths";
import { withQuery } from "../client-urls";
import { LunoraClient } from "../lunora-client";
import type {
    AuthCapabilities,
    AuthConfigInfo,
    AuthImpersonation,
    AuthPage,
    AuthSession,
    AuthUser,
    CronJobInfo,
    CronRunsResult,
    FunctionDescriptor,
    GlobalFacetResult,
    GlobalFilterClause,
    GlobalTableInfo,
    GlobalTablePage,
    KvKeyListResult,
    KvNamespaceSummary,
    KvValueResult,
    PipelineLogPage,
    PipelineLogQuery,
    ScheduledJobView,
    ScheduleRecord,
    SchedulerStatus,
    ShardTrafficResult,
    StorageListPage,
    VectorIndexSummary,
    VectorQueryMatch,
    WorkflowInstanceAction,
    WorkflowInstanceDetail,
    WorkflowInstancePage,
    WorkflowInstanceStatus,
} from "../types";
import { fetchArchitecture, fetchOpenApi, fetchOpenRpc, getCronJobs, listFunctions, runCronJob } from "./functions";
import { facetGlobalColumn, listGlobalTables, readGlobalTablePage } from "./global-tables";
import { deleteKvKey, getKvValue, listKvKeys, listKvNamespaces, putKvValue } from "./kv";
import { queryLogArchive, shardTraffic } from "./observability";
import {
    cancelScheduledJob,
    getScheduledJob,
    getWorkflowInstance,
    listCronRuns,
    listDeadJobs,
    listScheduledHistory,
    listScheduledJobs,
    listWorkflowInstances,
    removeDeadJob,
    retryDeadJob,
    schedulerStatus,
    setWorkflowInstanceStatus,
} from "./scheduler";
import { deleteStorageObject, listStorageBuckets, listStorageObjects, signedStorageUrl, uploadStorageObject } from "./storage";
import { listVectorIndexes, queryVectorIndex } from "./vector-indexes";

/**
 * A {@link LunoraClient} with the deployment-admin surface: the Studio's
 * functions, scheduler, workflow, storage, KV, vector, global-table and log
 * readers, and the better-auth admin (users, sessions, organizations, teams,
 * roles, invitations).
 *
 * These live on a subclass rather than on `LunoraClient` because class methods
 * never tree-shake: every web app shipped all of them. An app that only reads,
 * writes and subscribes constructs `LunoraClient` and pays nothing for them;
 * an admin tool constructs this instead.
 */
class LunoraAdminClient extends LunoraClient {
    // --- Advisor admin ------------------------------------------------------

    /**
     * Read the cross-shard request distribution for a `.shardBy(...)` table —
     * the feed the studio's `hot_shard` advisor lint consumes. Hits the
     * admin-gated `POST /_lunora/admin/shard-traffic` endpoint, which fans the
     * cheap per-shard `getMetrics` read out across every live shard and returns
     * each shard's `{ shardKey, requests }` total (a failed shard surfaces with
     * `requests: 0`). Requires the worker to be built with a `queryCoordinator`
     * and `adminToken`, and this client's auth token to match; defaults any
     * absent field so an older worker yields an empty-but-valid shape.
     */
    public async shardTraffic(table: string): Promise<ShardTrafficResult> {
        return shardTraffic(this.adminHost, table);
    }

    // --- Scheduler admin ----------------------------------------------------

    /**
     * List the functions queued via `runAfter` / `runAt`, soonest-due last
     * (the worker returns them in storage order). Hits the admin-gated
     * `/_lunora/admin/scheduled` endpoint, so the worker must be built with a
     * `schedulerDO` namespace and `adminToken`, and this client's auth token
     * must match. Powers `@lunora/studio`'s scheduled-jobs panel.
     */
    public async listScheduledJobs(): Promise<ScheduleRecord[]> {
        return listScheduledJobs(this.adminHost);
    }

    /**
     * Read the app-level workpool backlog that powers `@lunora/studio`'s SLO
     * view: per-pool `{ name, queued, inFlight, maxConcurrency }` plus the
     * app-wide `backlog` (total queued) and `inFlight` (total held slots) sums.
     * Hits the admin-gated `GET /_lunora/admin/scheduled/status` endpoint, so the
     * same preconditions as {@link listScheduledJobs} apply (a `schedulerDO`
     * namespace + `adminToken` on the worker and a matching auth token here).
     * Defaults any absent field so an older worker still yields a valid shape.
     */
    public async schedulerStatus(): Promise<SchedulerStatus> {
        return schedulerStatus(this.adminHost);
    }

    /**
     * One scheduled job with its lifecycle state — pending, running, or how it
     * ended (succeeded, failed, canceled) for the scheduler's retention window.
     * `null` for an id never scheduled or past retention. Hits the admin-gated
     * `GET /_lunora/admin/scheduled/job?id=`.
     */
    public async getScheduledJob(id: string): Promise<ScheduledJobView | null> {
        return getScheduledJob(this.adminHost, id);
    }

    /**
     * The most recently finished scheduled jobs, newest first — one page of the
     * scheduler's terminal records. Hits the admin-gated
     * `GET /_lunora/admin/scheduled/history`. Powers `@lunora/studio`'s
     * recent-jobs panel.
     */
    public async listScheduledHistory(): Promise<ScheduledJobView[]> {
        return listScheduledHistory(this.adminHost);
    }

    /**
     * The code-defined cron jobs' run history: which runs are in flight, and the
     * recorded fires (start, duration, outcome, error, ticks skipped because the
     * previous run was still going), newest first per job. Hits the admin-gated
     * `GET /_lunora/admin/scheduled/cron-runs`, so the worker needs a
     * `schedulerDO` — which every app declaring a cron has.
     */
    public async listCronRuns(): Promise<CronRunsResult> {
        return listCronRuns(this.adminHost);
    }

    /** Cancel a pending scheduled job by id. Returns whether a job was removed. */
    public async cancelScheduledJob(id: string): Promise<{ cancelled: boolean }> {
        return cancelScheduledJob(this.adminHost, id);
    }

    /**
     * List the dead-letter jobs: schedules that exhausted their retry budget
     * and were parked instead of dropped. These never appear in
     * {@link listScheduledJobs} (their live header is gone), so this is the only
     * way the studio surfaces a permanently-failed job. Hits the admin-gated
     * `GET /_lunora/admin/scheduled/dead`; same preconditions as
     * {@link listScheduledJobs}. Powers `@lunora/studio`'s dead-letter panel.
     */
    public async listDeadJobs(): Promise<ScheduleRecord[]> {
        return listDeadJobs(this.adminHost);
    }

    /**
     * Resurrect a dead-letter job by id: it re-enters the schedule with a fresh
     * retry budget and fires on the next drain. Returns whether a parked record
     * matched. Hits the admin-gated `POST /_lunora/admin/scheduled/dead/retry`.
     */
    public async retryDeadJob(id: string): Promise<{ retried: boolean }> {
        return retryDeadJob(this.adminHost, id);
    }

    /**
     * Permanently drop a dead-letter job by id (the operator has decided not to
     * recover it). Returns whether a parked record was removed. Hits the
     * admin-gated `POST /_lunora/admin/scheduled/dead/cancel`.
     */
    public async removeDeadJob(id: string): Promise<{ removed: boolean }> {
        return removeDeadJob(this.adminHost, id);
    }

    /**
     * List a workflow's instances via the admin Workflows proxy
     * (`/_lunora/admin/workflows/instances`) — the Cloudflare control-plane data
     * the `Workflow` binding can't expose. Requires the worker to be built with a
     * `workflowsClient` (Cloudflare account id + API token). When one isn't
     * configured this does NOT reject: the proxy returns a `200 { configured:
     * false }` sentinel, so the result resolves with `configured === false` and an
     * empty `instances` list — callers should branch on that flag rather than
     * try/catch. (The instance-detail / status endpoints still reject with 501.)
     * `name` is the deployed workflow name.
     */
    public async listWorkflowInstances(options: {
        name: string;
        page?: number;
        perPage?: number;
        status?: WorkflowInstanceStatus;
    }): Promise<WorkflowInstancePage> {
        return listWorkflowInstances(this.adminHost, options);
    }

    /** Read one workflow instance with its step timeline (`/_lunora/admin/workflows/instance`). */
    public async getWorkflowInstance(options: { id: string; name: string }): Promise<WorkflowInstanceDetail> {
        return getWorkflowInstance(this.adminHost, options);
    }

    /** Pause / resume / restart / terminate a workflow instance (`/_lunora/admin/workflows/status`). Needs an Edit-scoped Cloudflare token. */
    public async setWorkflowInstanceStatus(options: { action: WorkflowInstanceAction; id: string; name: string }): Promise<{ status: WorkflowInstanceStatus }> {
        return setWorkflowInstanceStatus(this.adminHost, options);
    }

    // --- Functions admin ----------------------------------------------------

    /**
     * List the registered public functions (queries / mutations / actions) with
     * their kinds. Hits the admin-gated `GET /_lunora/admin/functions` endpoint —
     * the worker must be built with a `functions` registry and `adminToken`, and
     * this client's auth token must match. Powers `@lunora/studio`'s function
     * runner auto-discovery.
     */
    public async listFunctions(): Promise<FunctionDescriptor[]> {
        return listFunctions(this.adminHost);
    }

    /**
     * List the code-defined cron triggers (the `cronJobs()` map injected on the
     * worker), each flattened to its firing `cron` expression. Hits the
     * admin-gated `GET /_lunora/admin/cron-jobs` endpoint — the worker must be
     * built with a `cronJobs` map and `adminToken`, and this client's auth token
     * must match. These are static (Cloudflare exposes no runtime cron
     * introspection), so the studio renders them read-only alongside the dynamic
     * scheduler jobs.
     */
    public async getCronJobs(): Promise<CronJobInfo[]> {
        return getCronJobs(this.adminHost);
    }

    /**
     * Manually fire one code-defined cron job by name — the same dispatch the
     * scheduled trigger runs (dispatch the function, or start the durable
     * workflow), on demand. Hits the admin-gated `POST /_lunora/admin/cron-jobs/run`
     * endpoint; the worker must be built with a `cronJobs` map and `adminToken`,
     * and this client's auth token must match. Resolves when the job has run (a
     * function job's shard response is 2xx, or the workflow instance was created)
     * and rejects with the dispatch error otherwise.
     */
    public async runCronJob(name: string): Promise<{ name: string; ran: boolean }> {
        return runCronJob(this.adminHost, name);
    }

    /**
     * Fetch the generated OpenAPI 3.1 document. Hits the admin-gated
     * `GET /_lunora/admin/openapi` endpoint — the worker must be built with an
     * `openApiSpec` and `adminToken`, and this client's auth token must match.
     * Powers `@lunora/studio`'s API-reference (Scalar) view. When the worker has
     * no spec wired, the endpoint still resolves with an empty-but-valid OpenAPI
     * document (no `paths`), so callers can render a "not configured" state.
     */
    public async fetchOpenApi(): Promise<Record<string, unknown>> {
        return fetchOpenApi(this.adminHost);
    }

    /**
     * Fetch the generated architecture manifest (module catalog + static call
     * graph). Hits the admin-gated `GET /_lunora/admin/architecture` endpoint.
     * Codegen emits the manifest once the app declares a module
     * (`lunora/<dir>/module.ts`); until then the endpoint answers an empty one
     * (no modules, nodes or edges). Powers `@lunora/studio`'s Architecture view.
     */
    public async fetchArchitecture(): Promise<Record<string, unknown>> {
        return fetchArchitecture(this.adminHost);
    }

    /**
     * Fetch the generated OpenRPC 1.x document. Hits the admin-gated
     * `GET /_lunora/admin/openrpc` endpoint — the worker must be built with an
     * `openRpcSpec` and `adminToken`, and this client's auth token must match.
     * OpenRPC is the RPC-native spec (a `methods` array over the JSON-RPC-shaped
     * `POST /_lunora/rpc` transport); it documents the RPC functions only.
     * Powers `@lunora/studio`'s OpenRPC API-reference view. When the worker has
     * no spec wired, the endpoint still resolves with an empty-but-valid OpenRPC
     * document (no `methods`), so callers can render a "not configured" state.
     */
    public async fetchOpenRpc(): Promise<Record<string, unknown>> {
        return fetchOpenRpc(this.adminHost);
    }

    // --- Storage admin ------------------------------------------------------

    /**
     * List objects in the storage bucket, optionally under a `prefix` and from a
     * pagination `cursor`. Hits the admin-gated `GET /_lunora/admin/storage`
     * endpoint — the worker must be built with a `storageList` function and
     * `adminToken`, and this client's auth token must match. Powers
     * `@lunora/studio`'s file browser.
     */
    public async listStorageObjects(options: { bucket?: string; cursor?: string; limit?: number; prefix?: string } = {}): Promise<StorageListPage> {
        return listStorageObjects(this.adminHost, options);
    }

    /**
     * Delete one object from the storage bucket by key. Hits the admin-gated
     * `DELETE /_lunora/admin/storage?key=…` endpoint — the worker must be built
     * with a `storageDelete` function and `adminToken`. Powers the studio file
     * browser's per-row delete; resolves `{ deleted, key }`.
     *
     * An absent `deleted` field reads as `false`, matching every sibling admin
     * verb (`runCronJob`'s `ran`, …): the studio renders this value as the row's
     * outcome, so defaulting a missing field to success would report a delete
     * that a mismatched/older worker never performed.
     */
    public async deleteStorageObject(key: string, options?: { bucket?: string }): Promise<{ deleted: boolean; key: string }> {
        return deleteStorageObject(this.adminHost, key, options);
    }

    /**
     * List the storage bucket names the worker exposes, for the studio file
     * browser's bucket picker. Hits the admin-gated
     * `GET /_lunora/admin/storage/buckets` endpoint — always resolves (an empty
     * array when the worker configures no `storageBuckets`, i.e. single-bucket).
     */
    public async listStorageBuckets(): Promise<string[]> {
        return listStorageBuckets(this.adminHost);
    }

    /**
     * Upload one object to the storage bucket. Hits the admin-gated
     * `PUT /_lunora/admin/storage?key=…` endpoint with the raw body and an
     * optional `contentType` header — the worker must be built with a
     * `storageUpload` function and `adminToken`. Powers the studio file
     * browser's upload control; resolves `{ etag?, key }`.
     */
    public async uploadStorageObject(options: {
        body: ArrayBuffer | Blob;
        bucket?: string;
        contentType?: string;
        key: string;
    }): Promise<{ etag?: string; key: string }> {
        return uploadStorageObject(this.adminHost, options);
    }

    /**
     * Build a (signed or public) URL for one object. Hits the admin-gated
     * `GET /_lunora/admin/storage/url?key=…` endpoint — the worker must be built
     * with a `storageSignedUrl` function and `adminToken`. Powers the studio
     * file browser's copy-URL action; resolves the URL string.
     *
     * `options.expiresInSeconds` requests a share-link lifetime, which is
     * validated/clamped server-side. The options object mirrors the worker's
     * `StorageSignedUrlFunction` options (a `password` / download-limit are noted
     * as future fields there).
     */
    public async signedStorageUrl(key: string, options?: { bucket?: string; expiresInSeconds?: number }): Promise<string> {
        return signedStorageUrl(this.adminHost, key, options);
    }

    // --- Global (D1) tables admin -------------------------------------------

    /**
     * List the `.global()` (D1-backed) tables with their row counts. Hits the
     * admin-gated `GET /_lunora/admin/global/tables` endpoint — the worker must
     * be built with a `globalIntrospector` and `adminToken`. Powers the data
     * browser's global mode.
     */
    public async listGlobalTables(): Promise<GlobalTableInfo[]> {
        return listGlobalTables(this.adminHost);
    }

    /**
     * Read a page of rows from one `.global()` table. `filters` AND-narrows the
     * page to rows matching each `column = value` eq constraint — the drill-down a
     * facet-value click applies; the array is wire-encoded, JSON-encoded into the
     * `filters` query param, and the values are bound server-side.
     *
     * The response is `decodeWire`d. The worker encodes it (`readGlobalTablePage`
     * in `@lunora/d1`) because JSON cannot carry a `v.bigint()` column at all and
     * silently flattens a `v.bytes()` one to `{}` — so without the decode here the
     * grid renders the raw 3-element tagged array instead of the value. The shard
     * browser's twin already pairs the same way through `rpc`; this is the global
     * half of that symmetry.
     */
    public async readGlobalTablePage(options: { filters?: GlobalFilterClause[]; limit?: number; offset?: number; table: string }): Promise<GlobalTablePage> {
        return readGlobalTablePage(this.adminHost, options);
    }

    /**
     * Summarise the distinct values of one column in a `.global()` table over the
     * active view (the same eq `filters` the browser is previewing) — the global
     * twin of the shard browser's facet. Hits the admin-gated
     * `GET /_lunora/admin/global/facet` endpoint; `column` is validated + bound
     * server-side. Powers the global data browser's facet sidebar.
     *
     * Wire-encoded/decoded on both legs for the same reason
     * {@link LunoraAdminClient.readGlobalTablePage} is: a facet over a BLOB column
     * returns bytes, which `Response.json` flattens to `{}` — and since a facet
     * value is exactly what a click sends back as a `filters` clause, that is a
     * broken drill-down rather than a display glitch.
     */
    public async facetGlobalColumn(options: { column: string; filters?: GlobalFilterClause[]; limit?: number; table: string }): Promise<GlobalFacetResult> {
        return facetGlobalColumn(this.adminHost, options);
    }

    // --- Vector indexes admin -----------------------------------------------

    /**
     * List the schema's Vectorize indexes with their declared shape (table,
     * field, dimensions, metric, metadata) and live stats (vector count,
     * processing watermark) when the binding is reachable. Hits the admin-gated
     * `GET /_lunora/admin/vector/indexes` endpoint — the worker must be built
     * with a `vectorIntrospector` and `adminToken`. Powers the studio's vector
     * browser. Vectorize can't enumerate indexes at runtime, so this list comes
     * from the generated `LUNORA_VECTOR_INDEXES` registry.
     */
    public async listVectorIndexes(): Promise<VectorIndexSummary[]> {
        return listVectorIndexes(this.adminHost);
    }

    /**
     * Run a nearest-neighbour similarity query against one vector index: the
     * worker embeds `text` via the index's embedder and returns the top matches.
     * Hits the admin-gated `POST /_lunora/admin/vector/query` endpoint. Throws
     * `VECTOR_QUERY_UNSUPPORTED` when the worker's introspector has no embedder
     * wired (the index lists read-only).
     */
    public async queryVectorIndex(options: { name: string; text: string; topK?: number }): Promise<VectorQueryMatch[]> {
        return queryVectorIndex(this.adminHost, options);
    }

    /**
     * Read one keyset-paginated page of the durable `ctx.log` archive that
     * `pipelineLogSink` writes to R2. Server-side only — the worker holds the R2
     * SQL credentials and runs the reader; the browser only sees the decoded
     * `{ rows, nextCursor }`. Pass the previous page's `nextCursor` as
     * `query.cursor` to page. Admin-gated. When the operator hasn't wired the
     * archive, `adminFetch` throws a `LunoraClientError` with `.code ===
     * "LOG_ARCHIVE_NOT_CONFIGURED"`, so a caller can render a "not configured"
     * state rather than an error.
     */
    public async queryLogArchive(query: PipelineLogQuery = {}): Promise<PipelineLogPage> {
        return queryLogArchive(this.adminHost, query);
    }

    // --- KV namespace admin -------------------------------------------------

    /**
     * List the worker's registered Workers KV namespaces (binding names). Hits
     * the admin-gated `GET /_lunora/admin/kv/namespaces` endpoint — the worker
     * must be built with a `kvIntrospector` and `adminToken`. Powers the
     * studio's KV browser.
     */
    public async listKvNamespaces(): Promise<KvNamespaceSummary[]> {
        return listKvNamespaces(this.adminHost);
    }

    /**
     * List keys in a KV namespace, optionally filtered by `prefix` and
     * paginated via `cursor`. Hits the admin-gated
     * `GET /_lunora/admin/kv/keys` endpoint.
     */
    public async listKvKeys(options: { cursor?: string; limit?: number; namespace: string; prefix?: string }): Promise<KvKeyListResult> {
        return listKvKeys(this.adminHost, options);
    }

    /**
     * Read a KV value (as text) and its metadata. Hits the admin-gated
     * `GET /_lunora/admin/kv/value` endpoint. Returns `{ value: null, metadata: null }`
     * when the key is absent.
     */
    public async getKvValue(options: { key: string; namespace: string }): Promise<KvValueResult> {
        return getKvValue(this.adminHost, options);
    }

    /**
     * Write a string value to a KV namespace. Accepts an absolute `expiration`
     * (Unix seconds) or a relative `expirationTtl`, plus optional `metadata` —
     * re-send the loaded values on edit so a save preserves rather than clears
     * them. Hits the admin-gated `PUT /_lunora/admin/kv/value` endpoint.
     */
    public async putKvValue(options: {
        expiration?: number;
        expirationTtl?: number;
        key: string;
        metadata?: unknown;
        namespace: string;
        value: string;
    }): Promise<void> {
        return putKvValue(this.adminHost, options);
    }

    /**
     * Delete a key from a KV namespace. No-op when the key is absent. Hits the
     * admin-gated `DELETE /_lunora/admin/kv/value` endpoint.
     */
    public async deleteKvKey(options: { key: string; namespace: string }): Promise<void> {
        return deleteKvKey(this.adminHost, options);
    }

    // --- Auth admin ---------------------------------------------------------

    /**
     * List authenticated users, paged and optionally searched / filtered / sorted.
     * Hits the admin-gated `GET /_lunora/admin/auth/users` endpoint — the worker
     * must be built with an `authAdmin` and `adminToken`. Powers the studio's
     * users dashboard.
     */
    public async listAuthUsers(
        options: {
            filterField?: string;
            filterValue?: string;
            limit?: number;
            offset?: number;
            search?: string;
            searchField?: string;
            sortBy?: string;
            sortDirection?: "asc" | "desc";
        } = {},
    ): Promise<AuthPage<AuthUser>> {
        this.adminHost.assertOpen();

        const path = withQuery(AUTH_USERS_PATH, {
            filterField: options.filterField,
            filterValue: options.filterValue,
            limit: options.limit,
            offset: options.offset,
            search: options.search,
            searchField: options.searchField,
            sortBy: options.sortBy,
            sortDirection: options.sortDirection,
        });

        return (await this.adminHost.adminFetch(path, "GET")) as AuthPage<AuthUser>;
    }

    /**
     * Create a user. Hits the admin-gated `POST /_lunora/admin/auth/users/create`
     * endpoint (requires the worker's `authAdmin` to implement `createUser`).
     * `data` carries any app-defined `user.additionalFields`.
     */
    public async createAuthUser(input: {
        data?: Record<string, unknown>;
        email: string;
        name: string;
        password?: string;
        role?: string | string[];
    }): Promise<AuthUser> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_CREATE_USER_PATH, "POST", input)) as AuthUser;
    }

    /** Set a user's role (string, or array joined comma-wise server-side). */
    public async setAuthUserRole(input: { role: string | string[]; userId: string }): Promise<AuthUser> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_SET_ROLE_PATH, "POST", input)) as AuthUser;
    }

    /** Ban a user. `expiresInSeconds` sets a temporary ban; omit it for a permanent one. Revokes the user's live sessions. */
    public async banAuthUser(input: { expiresInSeconds?: number; reason?: string; userId: string }): Promise<AuthUser> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_BAN_PATH, "POST", input)) as AuthUser;
    }

    /** Lift a user's ban. */
    public async unbanAuthUser(input: { userId: string }): Promise<AuthUser> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_UNBAN_PATH, "POST", input)) as AuthUser;
    }

    /** Set a user's password (admin override — no current-password challenge). */
    public async setAuthUserPassword(input: { newPassword: string; userId: string }): Promise<void> {
        this.adminHost.assertOpen();
        await this.adminHost.adminFetch(AUTH_SET_PASSWORD_PATH, "POST", input);
    }

    /** Permanently delete a user and revoke their sessions. */
    public async removeAuthUser(input: { userId: string }): Promise<void> {
        this.adminHost.assertOpen();
        await this.adminHost.adminFetch(AUTH_REMOVE_USER_PATH, "POST", input);
    }

    /**
     * Mint an impersonation session for a user, returning its bearer `token`.
     * The caller is responsible for using the token (e.g. setting the session
     * cookie); the server performs no cookie round-trip.
     */
    public async impersonateAuthUser(input: { userId: string }): Promise<AuthImpersonation> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_IMPERSONATE_PATH, "POST", input)) as AuthImpersonation;
    }

    /** Revoke a single session by its id (force sign-out of one device). */
    public async revokeAuthSession(input: { sessionId: string }): Promise<void> {
        this.adminHost.assertOpen();
        await this.adminHost.adminFetch(AUTH_REVOKE_SESSION_PATH, "POST", input);
    }

    /** Revoke every session for a user (force sign-out everywhere). */
    public async revokeAuthUserSessions(input: { userId: string }): Promise<void> {
        this.adminHost.assertOpen();
        await this.adminHost.adminFetch(AUTH_REVOKE_SESSIONS_PATH, "POST", input);
    }

    /**
     * Report which auth dashboard surfaces are available — derived server-side
     * from the enabled better-auth plugins. The studio renders only the panels
     * whose capability is `true`.
     */
    public async getAuthCapabilities(): Promise<AuthCapabilities> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_CAPABILITIES_PATH, "GET")) as AuthCapabilities;
    }

    /** Update a user's fields (name/email/app-defined `additionalFields`). */
    public async updateAuthUser(input: { data: Record<string, unknown>; userId: string }): Promise<AuthUser> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_UPDATE_USER_PATH, "POST", input)) as AuthUser;
    }

    /** List a user's linked accounts (credential / OAuth providers). Token material is stripped server-side. */
    public async listAuthAccounts(input: { userId: string }): Promise<Record<string, unknown>[]> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(withQuery(AUTH_ACCOUNTS_PATH, { userId: input.userId }), "GET")) as Record<string, unknown>[];
    }

    /** Unlink a linked account from a user. */
    public async unlinkAuthAccount(input: { accountId: string; userId: string }): Promise<void> {
        this.adminHost.assertOpen();
        await this.adminHost.adminFetch(AUTH_UNLINK_ACCOUNT_PATH, "POST", input);
    }

    /** List a user's registered passkeys (requires the passkey plugin). */
    public async listAuthPasskeys(input: { userId: string }): Promise<Record<string, unknown>[]> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(withQuery(AUTH_PASSKEYS_PATH, { userId: input.userId }), "GET")) as Record<string, unknown>[];
    }

    /** Delete a passkey by id (requires the passkey plugin). */
    public async deleteAuthPasskey(input: { passkeyId: string }): Promise<void> {
        this.adminHost.assertOpen();
        await this.adminHost.adminFetch(AUTH_DELETE_PASSKEY_PATH, "POST", input);
    }

    /** Disable two-factor auth for a user (requires the two-factor plugin). */
    public async disableAuthTwoFactor(input: { userId: string }): Promise<void> {
        this.adminHost.assertOpen();
        await this.adminHost.adminFetch(AUTH_DISABLE_2FA_PATH, "POST", input);
    }

    /** List organizations, paged (requires the organization plugin). */
    public async listAuthOrganizations(options: { limit?: number; offset?: number } = {}): Promise<AuthPage<Record<string, unknown>>> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(withQuery(AUTH_ORGS_PATH, { limit: options.limit, offset: options.offset }), "GET")) as AuthPage<
            Record<string, unknown>
        >;
    }

    /** List the members of an organization (requires the organization plugin). */
    public async listAuthOrgMembers(input: { limit?: number; offset?: number; organizationId: string }): Promise<AuthPage<Record<string, unknown>>> {
        this.adminHost.assertOpen();
        const path = withQuery(AUTH_ORG_MEMBERS_PATH, { limit: input.limit, offset: input.offset, organizationId: input.organizationId });

        return (await this.adminHost.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
    }

    /** List an organization's pending invitations (requires the organization plugin). */
    public async listAuthOrgInvitations(input: { limit?: number; offset?: number; organizationId: string }): Promise<AuthPage<Record<string, unknown>>> {
        this.adminHost.assertOpen();
        const path = withQuery(AUTH_ORG_INVITATIONS_PATH, { limit: input.limit, offset: input.offset, organizationId: input.organizationId });

        return (await this.adminHost.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
    }

    /**
     * List sign-up invitations, newest first (requires the `inviteOnly` plugin).
     * Unfiltered: a row is pending when `acceptedAt` is null and `expiresAt` is in
     * the future, and the caller labels it — filtering server-side after the page
     * would let page 1 come back empty while pending rows sat on page 2.
     */
    public async listAuthSignUpInvitations(options: { limit?: number; offset?: number } = {}): Promise<AuthPage<Record<string, unknown>>> {
        this.adminHost.assertOpen();
        const path = withQuery(AUTH_SIGN_UP_INVITATIONS_PATH, { limit: options.limit, offset: options.offset });

        return (await this.adminHost.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
    }

    /** Invite an address to sign up, or refresh an existing invitation for it. */
    public async createAuthSignUpInvitation(input: { email: string; expiresInSeconds?: number; invitedBy?: string }): Promise<Record<string, unknown>> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_CREATE_SIGN_UP_INVITATION_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** Withdraw a sign-up invitation. Not retroactive — an account already created keeps existing. */
    public async revokeAuthSignUpInvitation(input: { email: string }): Promise<void> {
        this.adminHost.assertOpen();
        await this.adminHost.adminFetch(AUTH_REVOKE_SIGN_UP_INVITATION_PATH, "POST", input);
    }

    public async removeAuthOrgMember(input: { memberId: string }): Promise<void> {
        this.adminHost.assertOpen();
        await this.adminHost.adminFetch(AUTH_REMOVE_MEMBER_PATH, "POST", input);
    }

    public async cancelAuthOrgInvitation(input: { invitationId: string }): Promise<void> {
        this.adminHost.assertOpen();
        await this.adminHost.adminFetch(AUTH_CANCEL_INVITATION_PATH, "POST", input);
    }

    /**
     * Report the deployment's auth configuration — enabled plugins, sign-in
     * methods, user-settable create-user fields, organization sub-features
     * (teams / roles), and session / rate-limit policy. Drives the config panel
     * and the dynamic create-user form. Never carries a secret.
     */
    public async getAuthConfig(): Promise<AuthConfigInfo> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_CONFIG_PATH, "GET")) as AuthConfigInfo;
    }

    /** Create an organization; optionally seed an `owner` member for `ownerId`. */
    public async createAuthOrganization(input: {
        logo?: string;
        metadata?: Record<string, unknown>;
        name: string;
        ownerId?: string;
        slug?: string;
    }): Promise<Record<string, unknown>> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_CREATE_ORG_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** Update an organization's name/slug/logo/metadata. */
    public async updateAuthOrganization(input: {
        logo?: string;
        metadata?: Record<string, unknown>;
        name?: string;
        organizationId: string;
        slug?: string;
    }): Promise<Record<string, unknown>> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_UPDATE_ORG_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** Delete an organization and cascade its members, invitations, teams, and custom roles. */
    public async deleteAuthOrganization(input: { organizationId: string }): Promise<void> {
        this.adminHost.assertOpen();
        await this.adminHost.adminFetch(AUTH_REMOVE_ORG_PATH, "POST", input);
    }

    /** Directly add an existing user to an organization (no invitation/acceptance). */
    public async addAuthOrgMember(input: { organizationId: string; role?: string; userId: string }): Promise<Record<string, unknown>> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_ADD_MEMBER_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** Create a pending email invitation to an organization. */
    public async inviteAuthOrgMember(input: { email: string; inviterId?: string; organizationId: string; role?: string }): Promise<Record<string, unknown>> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_INVITE_MEMBER_PATH, "POST", input)) as Record<string, unknown>;
    }

    public async setAuthOrgMemberRole(input: { memberId: string; role: string | string[] }): Promise<Record<string, unknown>> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_MEMBER_ROLE_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** List an organization's teams (requires the organization plugin with teams enabled). */
    public async listAuthOrgTeams(input: { limit?: number; offset?: number; organizationId: string }): Promise<AuthPage<Record<string, unknown>>> {
        this.adminHost.assertOpen();
        const path = withQuery(AUTH_ORG_TEAMS_PATH, { limit: input.limit, offset: input.offset, organizationId: input.organizationId });

        return (await this.adminHost.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
    }

    /** Create a team under an organization. */
    public async createAuthOrgTeam(input: { name: string; organizationId: string }): Promise<Record<string, unknown>> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_CREATE_TEAM_PATH, "POST", input)) as Record<string, unknown>;
    }

    public async updateAuthOrgTeam(input: { name: string; teamId: string }): Promise<Record<string, unknown>> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_UPDATE_TEAM_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** Delete a team and its memberships. */
    public async removeAuthOrgTeam(input: { teamId: string }): Promise<void> {
        this.adminHost.assertOpen();
        await this.adminHost.adminFetch(AUTH_REMOVE_TEAM_PATH, "POST", input);
    }

    public async listAuthOrgTeamMembers(input: { limit?: number; offset?: number; teamId: string }): Promise<AuthPage<Record<string, unknown>>> {
        this.adminHost.assertOpen();
        const path = withQuery(AUTH_ORG_TEAM_MEMBERS_PATH, { limit: input.limit, offset: input.offset, teamId: input.teamId });

        return (await this.adminHost.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
    }

    public async addAuthOrgTeamMember(input: { teamId: string; userId: string }): Promise<Record<string, unknown>> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_ADD_TEAM_MEMBER_PATH, "POST", input)) as Record<string, unknown>;
    }

    public async removeAuthOrgTeamMember(input: { teamMemberId: string }): Promise<void> {
        this.adminHost.assertOpen();
        await this.adminHost.adminFetch(AUTH_REMOVE_TEAM_MEMBER_PATH, "POST", input);
    }

    /** List an organization's custom roles (requires the organization plugin with dynamic access control). */
    public async listAuthOrgRoles(input: { limit?: number; offset?: number; organizationId: string }): Promise<AuthPage<Record<string, unknown>>> {
        this.adminHost.assertOpen();
        const path = withQuery(AUTH_ORG_ROLES_PATH, { limit: input.limit, offset: input.offset, organizationId: input.organizationId });

        return (await this.adminHost.adminFetch(path, "GET")) as AuthPage<Record<string, unknown>>;
    }

    /** Create a custom org role with a permission grant (a `resource -> actions[]` map). */
    public async createAuthOrgRole(input: { organizationId: string; permission: Record<string, string[]>; role: string }): Promise<Record<string, unknown>> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_CREATE_ROLE_PATH, "POST", input)) as Record<string, unknown>;
    }

    /** Replace a custom org role's permission grant. */
    public async updateAuthOrgRole(input: { permission: Record<string, string[]>; roleId: string }): Promise<Record<string, unknown>> {
        this.adminHost.assertOpen();
        return (await this.adminHost.adminFetch(AUTH_UPDATE_ROLE_PATH, "POST", input)) as Record<string, unknown>;
    }

    public async deleteAuthOrgRole(input: { roleId: string }): Promise<void> {
        this.adminHost.assertOpen();
        await this.adminHost.adminFetch(AUTH_REMOVE_ROLE_PATH, "POST", input);
    }

    /** List auth sessions, paged and optionally filtered to one user. */
    public async listAuthSessions(options: { limit?: number; offset?: number; userId?: string } = {}): Promise<AuthPage<AuthSession>> {
        this.adminHost.assertOpen();

        const path = withQuery(AUTH_SESSIONS_PATH, { limit: options.limit, offset: options.offset, userId: options.userId });

        return (await this.adminHost.adminFetch(path, "GET")) as AuthPage<AuthSession>;
    }
}

/**
 * Whether `client` carries the admin surface. Structural rather than
 * `instanceof`, so a client from a second copy of this package still passes.
 */
const isLunoraAdminClient = (client: LunoraClient): client is LunoraAdminClient => "listAuthUsers" in client;

export { isLunoraAdminClient, LunoraAdminClient };
