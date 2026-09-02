/**
 * The central Lunora error catalog — the single source of truth mapping a
 * machine-readable `code` to its transport `status`, a short human `title`, and
 * (where useful) an actionable Markdown `hint` plus a `docsUrl`.
 *
 * This table is consumed everywhere an error is surfaced: the runtime/DO wire
 * mappers (status), the client SDK (code discrimination), the CLI renderer and
 * the Vite overlay (hint), and the Studio UI (title + hint + docs link). It also
 * absorbs the former `@lunora/codegen` "solutions" table (see {@link MESSAGE_SOLUTIONS})
 * so codegen build-time errors — which are thrown as plain messages into
 * generated code and lose their class identity before a consumer sees them —
 * keep their message-matched hints.
 */

/* eslint-disable import/exports-last -- a data + types module: the public error-code types are declared next to the catalog they describe; grouping all exports at the end would scatter the taxonomy. */

/**
 * Canonical Cloudflare support-docs pages for the two platform-error families.
 * Private module constants, referenced by the {@link CLOUDFLARE_PLATFORM_ERRORS}
 * table below.
 */
const CF_5XX_DOCS = "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/";
const CF_1XXX_DOCS = "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/";

/** SQLite phrases `SQLITE_TOOBIG` as "string or blob too big"; D1 surfaces the same text through its own error envelope. */
const ROW_TOO_BIG_RE = /string or blob too big/iu;

/** Markdown hint: a single string or an array of lines. Shape matches `@visulima/error`'s `hint`. */
export type ErrorHint = string | ReadonlyArray<string>;

/** A catalog entry: the fixed metadata for one error `code`. */
export interface ErrorCatalogEntry {
    /** Optional URL to deeper docs for this error. */
    docsUrl?: string;
    /** Optional actionable fix, authored as Markdown (rendered by CLI/overlay/Studio). */
    hint?: ErrorHint;

    /**
     * When `true`, this code's `message` must NOT cross the wire — an internal
     * failure or unhandled invariant may carry SQL fragments, file paths, or
     * internal identifiers. The transport mappers emit a generic message for
     * these (and log the real one server-side). See {@link isInternalCode}.
     */
    internal?: boolean;
    /** HTTP/RPC status this code maps to on the wire. */
    status: number;
    /** Short, human-readable summary. */
    title: string;
}

/**
 * Every well-known Lunora error code. Domain packages may throw additional
 * codes (passing an explicit `status`); those are added here as their package is
 * migrated. The keys of this object form the {@link LunoraErrorCode} union.
 */
export const ERROR_CATALOG = {
    BAD_REQUEST: { status: 400, title: "Bad request" },
    UNAUTHORIZED: { status: 401, title: "Unauthorized" },
    FORBIDDEN: { status: 403, title: "Forbidden" },
    NOT_FOUND: { status: 404, title: "Not found" },

    CONFLICT: {
        hint: [
            "Another write changed this row while your mutation was running (optimistic concurrency conflict).",
            "",
            "Re-read the row and retry the mutation with the fresh value. Lunora serializes a DO's mutations, so a persistent conflict usually means the handler conflicts **with itself** (e.g. a trigger or cascade touching the same row) — split that work rather than adding a retry loop.",
        ],
        status: 409,
        title: "Conflict",
    },
    NOT_UNIQUE: {
        hint: [
            "`.unique()` matched more than one document — it expects the query to identify at most one row.",
            "",
            "- If several matches are legitimate, use `.first()` (take one) or `.collect()` (take all) instead.",
            "- Otherwise tighten the query (e.g. filter on a unique/indexed field) so it can only match one row.",
        ],
        status: 400,
        title: "Query matched more than one document",
    },
    VALIDATION_ERROR: { status: 400, title: "Validation failed" },

    TOO_MANY_REQUESTS: { status: 429, title: "Too many requests" },
    UNPROCESSABLE: { status: 422, title: "Unprocessable" },
    NOT_IMPLEMENTED: { status: 501, title: "Not implemented" },

    /** RPC/REST dispatch codes emitted by the runtime + Durable Object router. */
    FUNCTION_NOT_FOUND: { status: 404, title: "Function not found" },
    METHOD_NOT_ALLOWED: { status: 405, title: "Method not allowed" },
    PAYLOAD_TOO_LARGE: { status: 413, title: "Payload too large" },

    /** Free-form internal failure — redacted to a generic message on the wire. */
    INTERNAL: { internal: true, status: 500, title: "Internal error" },
    /** Alias of {@link ERROR_CATALOG.INTERNAL} kept for `@lunora/server`'s historical code name. */
    INTERNAL_SERVER_ERROR: { internal: true, status: 500, title: "Internal error" },
    /** Non-mappable throw crossed the RPC boundary. */
    RPC_FAILED: { internal: true, status: 500, title: "Internal error" },

    COUNT_RLS_UNSUPPORTED: { status: 422, title: "count() is unsupported under an RLS policy" },
    MASK_UNSUPPORTED: { status: 422, title: "Aggregation over a masked column is unsupported" },
    RELATION_PREDICATE_UNSUPPORTED: { status: 422, title: "Relation predicate is unsupported in a write policy" },
    RLS_REQUIRED: {
        hint: [
            "This table is secure-by-default: it has no `.public()` marker and no RLS policy resolved for the caller, so the read fails closed.",
            "",
            "Add a read policy with `.rls(...)`, or mark the table `.public()` if it is intentionally world-readable.",
        ],
        status: 403,
        title: "RLS policy required",
    },

    RUN_DEPTH_EXCEEDED: { internal: true, status: 500, title: "Run depth exceeded" },
    TRANSACTION_LIMIT_EXCEEDED: {
        hint: [
            "A single mutation may only read and write a bounded amount before it is stopped.",
            "",
            "Narrow the read with an index (`.withIndex(...)`) instead of scanning the table, or split the write across several mutations — for a large backfill use `defineMigration` + `lunora migrate up`, which batches and checkpoints for you.",
            "",
            "The ceilings are deliberately conservative — they exist to stop one request taking down the whole shard. A deployment that genuinely needs bigger transactions can raise them by overriding the `transactionLimits()` seam on its generated shard class.",
        ],
        status: 413,
        title: "Transaction limit exceeded",
    },
    MIGRATION_NOT_FOUND: { status: 404, title: "Data migration not found" },
    UNKNOWN_TABLE: { status: 404, title: "Unknown table" },
    GLOBAL_TABLE_NOT_EDITABLE: { status: 400, title: "Global table is not editable" },

    SHARD_ERROR: { status: 503, title: "Shard error" },
    SHARD_UNAVAILABLE: { status: 503, title: "Shard unavailable" },
    /** A fan-out shard call exceeded the coordinator's per-shard deadline. */
    SHARD_TIMEOUT: { status: 504, title: "Shard timeout" },
    /** A fan-out shard call answered with a non-2xx status; the status is in the message, the body is not. */
    SHARD_HTTP_ERROR: { status: 502, title: "Shard HTTP error" },
    /** The shard could not write a subscription's attachment to storage, so the subscription was refused. */
    SUBSCRIPTION_PERSIST_FAILED: { status: 500, title: "Subscription persist failed" },
    /** A connection asked for more concurrent subscriptions than the shard allows. */
    TOO_MANY_SUBSCRIPTIONS: { status: 429, title: "Too many subscriptions" },
    OFFLINE_IDENTITY_CHANGED: { status: 409, title: "Offline identity changed" },

    /** Package-specific codes. Build-time-only — never cross the RPC wire, so deliberately not `internal`. */
    CODEGEN_DIAGNOSTIC: { status: 500, title: "Codegen diagnostic" },
    /** Build-time-only — never crosses the RPC wire, so deliberately not `internal`. */
    SCHEMA_SNAPSHOT_PARSE: { status: 500, title: "Schema snapshot parse error" },
    /** Runtime-reachable (env.ts): message enumerates failing env key names — redact on the wire. */
    ENV_INVALID: { internal: true, status: 500, title: "Invalid environment" },
    /** Runtime-reachable (auth/middleware.ts): message carries auth-wiring guidance — redact on the wire. */
    AUTH_HEADERS_MISSING: { internal: true, status: 500, title: "Auth headers missing" },

    /**
     * Signup rejected by `@lunora/auth`'s email-domain gate — a disposable/throwaway
     * provider (or a caller deny-list hit). Client-safe: the message names only the
     * offending domain class, never a secret, so it is echoed rather than redacted.
     */
    EMAIL_DOMAIN_BLOCKED: {
        hint: [
            "This address's domain is on the disposable/throwaway blocklist (or your configured deny-list).",
            "",
            "Sign up with a permanent mailbox. To tune the policy, pass `blockDisposable` / `allowDomains` / `denyDomains` to `emailGate(...)` (`@lunora/auth/email-guard`).",
        ],
        status: 400,
        title: "Email domain not allowed",
    },

    /**
     * Opt-in MX verification (`@lunora/auth/email-guard`, `mx: true`) found no mail
     * exchanger for the address's domain, so mail to it would never deliver.
     * Client-safe: names only the domain, no secret.
     */
    EMAIL_UNDELIVERABLE: {
        hint: [
            "The address's domain publishes no MX (or fallback A/AAAA) records, so it can't receive mail.",
            "",
            "Check for a typo in the domain. MX verification is opt-in (`mx: true`) and needs DNS — leave it off on the edge path if DNS is unavailable.",
        ],
        status: 400,
        title: "Email domain cannot receive mail",
    },

    /**
     * Upstream Cloudflare API failures surfaced from an action. The message
     * carries the upstream response body (Cloudflare's own error text — trusted
     * infra, not user input), so it is echoed rather than redacted. `status`
     * here is a fallback; each throw passes the actual upstream HTTP status.
     */
    ANALYTICS_SQL_ERROR: { status: 502, title: "Analytics Engine SQL API error" },
    R2_SQL_ERROR: { status: 502, title: "R2 SQL API error" },
    WORKFLOWS_REST_ERROR: { status: 502, title: "Cloudflare Workflows REST API error" },

    /**
     * Admin-gated `/_lunora/admin/*` and `__lunora_admin__:*` codes. Registered
     * here (plan 230, ERRORS-01) after an audit found them minted with `code:`
     * but never added to the catalog — `isInternalCode` fails OPEN for an
     * unregistered code, so each was already echoing its message unredacted.
     * Below is that audit's verdict per code, not a blanket allow: most of these
     * are deliberately actionable ("you forgot to configure X") and stay
     * client-safe; the ones that can carry backend detail are flagged
     * `internal: true` individually, with the reason noted alongside.
     */
    ADMIN_FORBIDDEN: { status: 403, title: "Admin access forbidden" },
    ADMIN_TOKEN_NOT_CONFIGURED: { status: 400, title: "Admin token not configured" },
    AUTH_NOT_CONFIGURED: { status: 400, title: "Auth admin not configured" },
    AUTH_OP_NOT_SUPPORTED: { status: 400, title: "Auth admin operation not supported" },
    BACKUP_NOT_CONFIGURED: { status: 500, title: "Scheduled backup not configured" },
    BACKUP_RETENTION_NOT_CONFIGURED: {
        hint: [
            "`lunora backup prune` removes snapshots past the retention window, and this worker has no window: set `backupRetain` (how many to keep) and `backupCron` (which decides whose snapshots retention owns) on `createWorker`.",
            "",
            "Nothing was deleted. A default is deliberately not invented here — retention deleting on its own is exactly what this command exists to replace.",
        ],
        status: 400,
        title: "Backup retention window not configured",
    },
    BACKUP_TOO_LARGE: {
        hint: [
            "The scheduled backup is assembled inside the Worker isolate, so it caps the snapshot it will build. Nothing was written.",
            "",
            "The cap is on the NDJSON, not on peak memory: the export fan-out resolves every shard's rows before the first row is encoded, so a snapshot under the cap can still exhaust the isolate. It is set well below the isolate's limit for that reason.",
            "",
            "Narrow the snapshot with `backupTables`, or take this backup off-platform with `lunora backup create --bucket`, which runs on a machine rather than in an isolate. Backing up more often does not help — every run is a full snapshot.",
        ],
        status: 507,
        title: "Backup too large to assemble in a Worker",
    },
    CRON_JOBS_NOT_CONFIGURED: { status: 400, title: "Cron jobs not configured" },
    CRON_JOB_NOT_FOUND: { status: 404, title: "Cron job not found" },
    EXPORT_TAP_NOT_CONFIGURED: { status: 400, title: "Export tap not configured" },
    FUNCTIONS_NOT_CONFIGURED: { status: 400, title: "Functions registry not configured" },
    GLOBALS_NOT_CONFIGURED: { status: 400, title: "Global-table introspector not configured" },
    KV_NOT_CONFIGURED: { status: 400, title: "KV introspector not configured" },
    MIGRATION_ID_REQUIRED: { status: 400, title: "Migration id required" },
    PITR_UNAVAILABLE: { status: 409, title: "Point-in-time recovery unavailable" },
    SCHEDULER_NOT_CONFIGURED: { status: 400, title: "Scheduler not configured" },
    STORAGE_CHECKSUM_MISMATCH: {
        hint: [
            "The upload body did not match the declared `expectedSize` or `expectedSha256`, so nothing was written — this check fails closed.",
            "",
            "Re-read the bytes from the source export and retry the transfer. A persistent mismatch means the source blob is corrupt or truncated; fix the export rather than bypassing the check.",
        ],
        status: 400,
        title: "Storage checksum mismatch",
    },
    STORAGE_DELETE_NOT_CONFIGURED: { status: 400, title: "Storage delete not configured" },
    STORAGE_DOWNLOAD_NOT_CONFIGURED: {
        hint: [
            "`GET /_lunora/admin/storage/object` needs a `storageDownload` function on the worker. The generated app worker wires it up; a hand-written `createWorker({ ... })` has to pass `(key, opts) => pick(opts?.bucket).download(key)` — forwarding `opts.bucket` to the right bucket, and wrapping rather than passing `createStorage(...).download` itself, whose second parameter is a byte range.",
            "",
            "Without it a bucket-backed `lunora backup restore --bucket` cannot read the snapshot. The object is still readable out of band with `wrangler r2 object get`.",
        ],
        status: 400,
        title: "Storage download not configured",
    },
    STORAGE_NOT_CONFIGURED: { status: 400, title: "Storage not configured" },
    STORAGE_OBJECT_NOT_FOUND: { status: 404, title: "Storage object not found" },
    STORAGE_UPLOAD_NOT_CONFIGURED: { status: 400, title: "Storage upload not configured" },
    STORAGE_URL_NOT_CONFIGURED: { status: 400, title: "Storage signed URL not configured" },
    VECTORS_NOT_CONFIGURED: { status: 400, title: "Vector index introspector not configured" },
    VECTOR_QUERY_UNSUPPORTED: { status: 400, title: "Vector index querying not enabled" },
    WORKFLOWS_NOT_CONFIGURED: { status: 501, title: "Workflows not configured" },

    /** The auth/security audit read plane (`__lunora_admin__:getAuthAuditLog`). */
    AUTH_AUDIT_NOT_CONFIGURED: { status: 400, title: "Auth audit reader not configured" },

    /**
     * Backend/DB failure reading the auth audit store. The throw site already
     * keeps the message generic and logs the real error server-side only — flagged
     * `internal: true` anyway as the deliberate posture for "a backend read
     * failed", so a future edit that inlines the driver error can't leak it.
     */
    AUTH_AUDIT_READ_FAILED: { internal: true, status: 500, title: "Auth audit read failed" },

    /**
     * Cron-job codes. The `*_NOT_STATIC` / `_INVALID` family are codegen
     * build-time diagnostics — like `CODEGEN_DIAGNOSTIC`, they're thrown as plain
     * messages into the CLI/Vite-overlay output, never cross the RPC wire, and are
     * deliberately not `internal` (the message IS the fix). `CRON_JOB_FAILED` is
     * the one runtime-reachable code in this family — its message interpolates
     * binding/function/job names from the deployment, so it is flagged internal.
     */
    CRON_EXPR_INVALID: { status: 500, title: "Invalid cron expression" },
    CRON_EXPR_NOT_STATIC: { status: 500, title: "Cron expression is not statically analyzable" },
    CRON_JOB_FAILED: { internal: true, status: 500, title: "Cron job failed" },
    CRON_NAME_NOT_STATIC: { status: 500, title: "Cron job name is not statically analyzable" },
    CRON_NON_STATIC_FN: { status: 500, title: "Cron function reference is not statically analyzable" },
    CRON_NON_STATIC_VALUE: { status: 500, title: "Cron value is not statically analyzable" },
    CRON_SCHEDULE_INVALID: { status: 500, title: "Invalid cron schedule" },
    CRON_SCHEDULE_NOT_STATIC: { status: 500, title: "Cron schedule is not statically analyzable" },
    DUPLICATE_CRON_NAME: { status: 500, title: "Duplicate cron job name" },

    /** More codegen build-time diagnostics — see the cron-family comment above; same reasoning applies. */
    DUPLICATE_AGENT_BINDING: { status: 500, title: "Duplicate agent binding" },
    DUPLICATE_AGENT_CLASS: { status: 500, title: "Duplicate agent generated class name" },
    DUPLICATE_AGENT_NAME: { status: 500, title: "Duplicate agent name" },
    DUPLICATE_MIGRATION_ID: { status: 500, title: "Duplicate migration id" },
    DUPLICATE_QUEUE_BINDING: { status: 500, title: "Duplicate queue binding" },
    DUPLICATE_QUEUE_NAME: { status: 500, title: "Duplicate queue name" },
    DUPLICATE_WORKFLOW_CLASS: { status: 500, title: "Duplicate workflow generated class name" },
    MIGRATION_ID_NOT_STATIC: { status: 500, title: "Migration id is not statically analyzable" },
    NAMESPACE_COLLISION: { status: 500, title: "Function namespace collision" },

    /**
     * `@lunora/runtime`'s dispatch/security-boundary codes — RPC/HTTP entry, not
     * admin-gated. Fixed, non-sensitive messages throughout, so none are `internal`.
     */
    BAD_ROW: { status: 400, title: "Malformed import row" },
    BAD_SUBSCRIPTION_ARGS: { status: 400, title: "Invalid subscription arguments" },
    BATCH_LIMIT_EXCEEDED: { status: 400, title: "Batch limit exceeded" },
    CROSS_SHARD_RANK_UNSUPPORTED: { status: 400, title: "Cross-shard rank() is unsupported" },

    /**
     * The `/_lunora/scheduler/dispatch` entry rejected the request's own
     * signature/bearer — a worker/scheduler MISCONFIGURATION (missing, wrong, or
     * rotated `LUNORA_SCHEDULER_SECRET` / `LUNORA_ADMIN_TOKEN`), not a verdict on
     * the function being dispatched. Distinct from `FORBIDDEN`/`FORBIDDEN_SHARD`
     * because dispatch consumers classify a 403 as deterministic and stop
     * retrying: an auth failure clears the moment the secret is fixed, so it must
     * stay retryable or every queued message drains into the void while the
     * credential is wrong. See `isDeterministicDispatchFailure` in
     * `@lunora/dispatch`.
     */
    DISPATCH_UNAUTHENTICATED: {
        hint: "The scheduler could not authenticate to the worker. Check that `LUNORA_SCHEDULER_SECRET` matches on both sides, or that `LUNORA_ADMIN_TOKEN` is set and current.",
        status: 403,
        title: "Dispatch caller not authenticated",
    },
    FORBIDDEN_FANOUT: { status: 403, title: "Fan-out forbidden" },
    GLOBAL_SEARCH_SCORES_UNSUPPORTED: { status: 400, title: "collectWithScores() is unsupported on a global table" },
    FORBIDDEN_ORIGIN: { status: 403, title: "Origin forbidden" },
    FORBIDDEN_SHARD: { status: 403, title: "Shard access forbidden" },
    GLOBAL_NOT_CONFIGURED: { status: 400, title: "Global table import not configured" },
    INVALID_INPUT: { status: 400, title: "Invalid input" },
    RATE_LIMITED: { status: 429, title: "Rate limited" },

    /**
     * A read replica could not answer at the freshness the caller required. `421`
     * rather than an error class: it is a ROUTING verdict the runtime turns into
     * one retry against the owner, and a caller never sees it.
     */
    REPLICA_NOT_READY: { status: 421, title: "Replica not caught up" },
    /** A write reached a read replica. Same `421` routing verdict — writes belong to the owner. */
    REPLICA_READ_ONLY: { status: 421, title: "Replica is read-only" },

    /**
     * A search index is provisioned but still covers only part of its table, so
     * the read refuses rather than answering from the indexed prefix.
     *
     * `503` and retryable, but deliberately NOT `SERVICE_UNAVAILABLE`: nothing is
     * down. One index on one table is warming, every other read is fine, and the
     * backfill advances on each read — so a caller that retries makes progress,
     * where a generic outage code invites it to back off. The message names both
     * exits (wait, or run the `backfillSearch` admin op).
     */
    SEARCH_INDEX_BUILDING: { status: 503, title: "Search index is still building" },
    /** Thrown by `@lunora/auth` (Turnstile) and `@lunora/ratelimit` — an upstream dependency didn't respond. Fixed, safe message. */
    SERVICE_UNAVAILABLE: { status: 503, title: "Service unavailable" },

    /**
     * A shape was declared over, or whose predicate joins, a `.memory()` table. Refused at subscribe, because
     * the poke path replicates from `__cdc_log` and a memory table is deliberately
     * never appended to it — so the shape would seed once and then stay frozen
     * while the table changed underneath it. Same registration-time refusal as
     * `SHAPE_CROSS_SHARD_JOIN`, for the same reason: the diff can never move.
     */
    SHAPE_MEMORY_TABLE: { status: 400, title: "Shape over a memory table is unsupported" },
    SHAPE_CROSS_SHARD_JOIN: { status: 400, title: "Shape cross-shard join is unsupported" },
    UNAUTHENTICATED: { status: 401, title: "Unauthenticated" },

    /**
     * The client could not decode a frame the server sent for a subscription.
     *
     * `502` because the failure is upstream of the caller: their query was valid
     * and the payload that came back was not readable. Delivered to the
     * subscription's `onError` rather than thrown, so one bad frame cannot escape
     * the socket listener and abort every other subscription on the connection —
     * which is what it did before, while the status indicator still read
     * `connected` and the cursor silently stopped advancing.
     */
    WIRE_DECODE_FAILED: { status: 502, title: "Could not decode a server frame" },
    UNKNOWN_COLUMN: { status: 404, title: "Unknown column" },

    /**
     * `@lunora/do`'s ShardDO — WebSocket-frame codes, changelog-retention refusals
     * and SQLite-in-DO invariants.
     *
     * `NESTED_TRANSACTION` and `SQL_UNAVAILABLE` are "should never happen" state
     * invariants (mirrors `RUN_DEPTH_EXCEEDED`'s posture above): today's message
     * is static and safe, but flagged internal so a future edit that adds
     * diagnostic detail can't accidentally start leaking it. The two `CDC_*`
     * codes are the opposite — ordinary, expected, operator-configured outcomes
     * — and both are `409` because the cursor the caller holds is real but no
     * longer serveable, so the recovery is a snapshot rather than a retry.
     */
    /** A resume below the deleted changelog prefix: the entries are gone outright, for every consumer. */
    CDC_LOG_TRIMMED: { status: 409, title: "CDC log trimmed" },
    /** A resume below the compacted prefix: the keys survive but their post-images do not, so only a payload consumer (streaming export, replay-PITR, a read replica) is refused. */
    CDC_PAYLOAD_COMPACTED: { status: 409, title: "CDC payloads compacted" },
    EXPIRED: { status: 404, title: "Session expired" },
    NESTED_TRANSACTION: { internal: true, status: 500, title: "Nested transaction" },
    OUT_OF_ORDER: { status: 409, title: "Out-of-order mutation" },
    SHAPE_GLOBAL_TOO_LARGE: { status: 413, title: "Global shape too large" },
    SHAPE_NOT_FOUND: { status: 404, title: "Shape not found" },
    SHAPE_REQUIRES_CDC: { status: 409, title: "Shape requires change-data-capture" },
    SQL_UNAVAILABLE: { internal: true, status: 500, title: "SQL storage unavailable" },
    STREAM_INTERRUPTED: { status: 503, title: "Durable stream interrupted" },
    STREAM_TOO_LONG: { status: 507, title: "Durable stream exceeded its chunk ceiling" },
    TOKEN_EXPIRED: { status: 401, title: "Authentication token expired" },
    TOO_MANY_STREAMS: { status: 429, title: "Too many streams" },
    UNKNOWN_ADMIN_OP: { status: 404, title: "Unknown admin operation" },

    /**
     * `@lunora/platform-cloudflare`'s `SocketHost.accept` guard — a caller
     * supplied more accept-time tags (or a longer tag) than Cloudflare's
     * `acceptWebSocket` budget allows once the host's own identity tag is
     * reserved. Caller-actionable and safe (names counts, not internals) —
     * not `internal`.
     */
    SOCKET_TAG_BUDGET_EXCEEDED: { status: 400, title: "Socket tag budget exceeded" },

    /**
     * `@lunora/shard-engine`'s relay hub (cross-shard shape relay coordination).
     * Mirrors `SHARD_ERROR`/`SHARD_UNAVAILABLE` above: operational status for an
     * app's own relay topology, not a secret — not `internal`.
     */
    RELAY_CANNOT_SEED: { status: 500, title: "Relay cannot seed" },
    RELAY_MISCONFIGURED: { status: 500, title: "Relay misconfigured" },
    RELAY_SEED_FAILED: { status: 502, title: "Relay seed failed" },
    RELAY_SHAPE_UNROUTABLE: { status: 500, title: "Relay shape unroutable" },

    /**
     * A worker option required by the request path is absent (a deploy-config
     * gap, not a caller error) — the fixed message names the missing option, so
     * it's actionable and echoed. `MISCONFIGURED` is the one exception: its
     * message interpolates the caller-supplied `functionPath`, and it's the code
     * this plan's audit found live-leaking (`create-worker.ts`'s x402 gate).
     */
    MISCONFIGURED: { internal: true, status: 500, title: "Worker misconfigured" },

    /** `@lunora/nuxt`'s Nitro bridge: the request carried no Cloudflare bindings. Fixed, safe message. */
    LUNORA_RUNTIME_UNAVAILABLE: { status: 500, title: "Lunora runtime unavailable" },

    /**
     * `@lunora/replica`'s event-log Durable Object: generic request-handler
     * catch-all, mirroring `INTERNAL`/`INTERNAL_SERVER_ERROR`/`RPC_FAILED` above
     * — the real error is logged server-side only, never in this code's message.
     */
    INTERNAL_ERROR: { internal: true, status: 500, title: "Internal error" },

    /**
     * Client-SDK-only codes (`@lunora/client`), thrown locally in the browser/app
     * process rather than by the server — `internal`'s wire-redaction semantics
     * don't apply the same way here, since the "wire" is the app's own code
     * catching its own client's exception. Kept in the catalog for the client's
     * `code`-discrimination union and Studio/CLI rendering consistency.
     */
    BROWSER_TIMEOUT: { status: 504, title: "Browser operation timed out" },
    CLIENT_CLOSED: { status: 400, title: "Client is closed" },
    HTTP_STREAM_BAD_CHUNK: { status: 502, title: "Malformed HTTP stream chunk" },
    HTTP_STREAM_INTERRUPTED: { status: 502, title: "HTTP stream interrupted" },
    HTTP_STREAM_MISSING_PARAM: { status: 400, title: "HTTP stream missing path parameter" },
    HTTP_STREAM_NO_BODY: { status: 502, title: "HTTP stream response has no body" },
    HTTP_STREAM_STATUS: { status: 502, title: "HTTP stream request failed" },
    HTTP_STREAM_TRANSPORT: { status: 502, title: "HTTP stream transport error" },
    STREAM_BACKPRESSURE: { status: 429, title: "Stream backpressure" },
    STREAM_DISCONNECTED: { status: 503, title: "Stream disconnected" },
    STREAM_QUEUE_OVERFLOW: { status: 429, title: "Stream queue overflow" },

    /** `@lunora/db`'s offline outbox: a queued write targeted a collection removed/renamed in a later deploy. */
    UNKNOWN_MUTATION_FN: { status: 404, title: "Unknown mutation function" },
} as const;

// Shape validation kept as a standalone statement: `as const satisfies …` is not
// emittable under isolatedDeclarations (TS9010), but `LunoraErrorCode` needs the
// literal keys, so the catalog stays `as const` and its shape is checked here.
// eslint-disable-next-line no-void, sonarjs/void-use -- `void` makes the standalone `satisfies` type-check a statement without tripping no-unused-expressions
void (ERROR_CATALOG satisfies Record<string, ErrorCatalogEntry>);

/** A well-known Lunora error code (a key of {@link ERROR_CATALOG}). */
export type LunoraErrorCode = keyof typeof ERROR_CATALOG;

/**
 * Look up a catalog entry by `code`, or `undefined` when the code isn't
 * registered. The single guarded seam for reading `ERROR_CATALOG` by an
 * arbitrary string: because the catalog is a plain object literal, a bracket
 * read for an inherited key (e.g. `"constructor"`, `"toString"`) would resolve
 * to `Object.prototype`'s member instead of `undefined`, so this uses
 * `Object.hasOwn` to only ever return an own entry. Reused by the
 * `LunoraError` constructor, {@link isInternalCode}, and {@link resolveHint}.
 */
export const getCatalogEntry = (code: string): ErrorCatalogEntry | undefined =>
    Object.hasOwn(ERROR_CATALOG, code) ? (ERROR_CATALOG as Record<string, ErrorCatalogEntry>)[code] : undefined;

/**
 * True when `code` is an internal/redacted code — an internal failure or
 * unhandled invariant whose `message` must NOT cross the wire (it may carry SQL
 * fragments, file paths, or internal identifiers). Derived from the catalog's
 * `internal` flag so the redaction posture stays in one place (the table).
 * Throwing a `LunoraError` with any non-internal code is the author's vouch that
 * its message is client-safe; an unknown/unregistered code is treated as safe.
 */
export const isInternalCode = (code: string): boolean => getCatalogEntry(code)?.internal === true;

/**
 * A message-matched solution for errors that reach a consumer without a `code`
 * — chiefly `@lunora/codegen` build errors, which are thrown as plain messages
 * into generated code (and flattened to `{ message }` by the Vite overlay), so
 * the message text is the only stable join key. Ordered most- to least-specific;
 * the first matching rule wins.
 */
export interface Solution {
    /** Markdown body shown under the header. */
    body: string;
    /** Short header for the solution. */
    header: string;
    /** Stable id (used in DEBUG logs and tests). */
    id: string;
}

/** A {@link Solution} plus its message matcher. */
export interface SolutionRule extends Solution {
    /** True when this rule recognizes the error message. */
    test: (message: string) => boolean;
}

/**
 * Message-matched solutions (migrated verbatim from the former
 * `@lunora/codegen` solutions table). Re-exported by `@lunora/codegen` as
 * `LUNORA_SOLUTION_RULES` for backward compatibility.
 */
export const MESSAGE_SOLUTIONS: ReadonlyArray<SolutionRule> = [
    {
        body: [
            "A single row exceeded the storage engine's per-row ceiling — 2 MB on a Durable Object's SQLite, and 2,000,000 bytes on D1.",
            "",
            "The limit is on the STORED bytes, which are UTF-8: a document of multi-byte text (CJK, emoji) costs up to 3x its character count. `v.bytes()` and `v.bigint()` columns cost more again on a shard-local table, where the row stores both a SQL-comparable projection and the original.",
            "",
            "Keep the large payload out of the row and store a reference to it:",
            "",
            "```ts",
            // eslint-disable-next-line no-template-curly-in-string -- markdown code sample shown to the developer, not a template literal
            "const key = `uploads/${crypto.randomUUID()}`;",
            "await ctx.storage.uploads.put(key, bytes);",
            'await ctx.db.insert("documents", { storageKey: key, title });',
            "```",
            "",
            "R2 has no practical object-size ceiling, and the row stays small enough to read, index, and replicate.",
        ].join("\n"),
        header: "Row too large for the storage engine",
        id: "lunora-row-too-big",
        test: (message) => ROW_TOO_BIG_RE.test(message),
    },
    {
        body: [
            "Lunora codegen couldn't find a schema to generate from.",
            "",
            "Create `lunora/schema.ts` exporting a `defineSchema(...)` call:",
            "",
            "```ts",
            'import { defineSchema, defineTable, v } from "@lunora/server";',
            "",
            "export default defineSchema({",
            "  messages: defineTable({ body: v.string() }),",
            "});",
            "```",
            "",
            "Or run `lunora init` to scaffold Lunora (a sample `lunora/schema.ts` included) into your app.",
        ].join("\n"),
        header: "No Lunora schema found",
        id: "lunora-schema-missing",
        test: (message) => message.includes("defineSchema() not found") || message.includes("schema.ts not found at"),
    },
    {
        body: [
            "`defineSchema(...)` must be called with an **inline object literal** mapping table names to `defineTable(...)`:",
            "",
            "```ts",
            "export default defineSchema({",
            "  todos: defineTable({ title: v.string(), done: v.boolean() }),",
            "});",
            "```",
            "",
            "Codegen reads the schema statically, so it can't follow a variable or a spread — pass the object literal directly.",
        ].join("\n"),
        header: "`defineSchema()` needs an inline object literal",
        id: "lunora-schema-not-object-literal",
        test: (message) => message.includes("defineSchema() expects an object literal"),
    },
    {
        body: [
            "This table name collides with a built-in `ctx.db` member, so the generated client can't expose it.",
            "",
            "Rename the table to anything that isn't a reserved name (the error lists them) — e.g. `userAccounts` instead of `insert`.",
        ].join("\n"),
        header: "Table name is reserved",
        id: "lunora-table-reserved",
        test: (message) => message.includes("is reserved") && message.includes("ctx.db"),
    },
    {
        body: [
            "Two tables resolve to the same name — usually a base table and a schema **extension** both defining it.",
            "",
            "Rename one of them, or drop the duplicate from the extension. Each table name must be unique across `defineSchema(...)` and every `.extend(...)`.",
        ].join("\n"),
        header: "Duplicate table name",
        id: "lunora-table-duplicate",
        // Anchor on `.extend(` — the only Lunora throw for this is
        // `defineSchema(...).extend(...): table "x" already exists …`. Matching a
        // bare "already exists"/"extension" pair would false-positive on
        // unrelated forwarded errors (e.g. a "file already exists" + "extension").
        test: (message) => message.includes("already exists") && message.includes(".extend("),
    },
    {
        body: [
            '`.jurisdiction(...)` accepts only a **string literal** of `"eu"`, `"us"`, or `"fedramp"`:',
            "",
            "```ts",
            'defineSchema({ /* … */ }).jurisdiction("eu");',
            "```",
        ].join("\n"),
        header: "Invalid `.jurisdiction(...)` value",
        id: "lunora-jurisdiction",
        test: (message) => message.includes("unknown jurisdiction") || (message.includes("jurisdiction") && message.includes('"eu", "us", or "fedramp"')),
    },
    {
        body: [
            "The `unique` flag on an index must be a **literal** `true` or `false`, not a computed value — codegen needs to read it statically:",
            "",
            "```ts",
            'defineTable({ email: v.string() }).index("by_email", ["email"], { unique: true });',
            "```",
        ].join("\n"),
        header: "`unique` must be a literal",
        id: "lunora-unique-literal",
        test: (message) => message.includes("must be a literal") && message.includes("unique"),
    },
    {
        body: [
            "A declared container/workflow class isn't re-exported by your worker entry, so `wrangler deploy` would reject it.",
            "",
            "Add the generated re-export shown in the error to your worker entry (e.g. `src/index.ts`):",
            "",
            "```ts",
            'export * from "./lunora/_generated/containers";',
            "```",
        ].join("\n"),
        header: "Binding not exported by your worker entry",
        id: "lunora-worker-entry-export-gap",
        test: (message) => message.includes("not exported by your worker entry"),
    },
    {
        // Deliberately NOT ERROR_CATALOG.NOT_UNIQUE.hint: that code (and hint)
        // describes the read-side `.unique()` multi-match, while this matcher
        // fires on the WRITE-path message ("unique constraint violation on
        // <table>") thrown as a CONFLICT by an insert/patch breaching a
        // `unique` index — a different error class needing insert remediation.
        body: [
            "A row with the same value already exists in a `unique` index.",
            "",
            "- If you meant to upsert, use `ctx.db.<table>().upsert(...)` (or `.patch(...)` an existing row) instead of `.insert(...)`.",
            '- Otherwise pick a value that isn\'t already taken, and consider surfacing a friendly "already exists" message to the user.',
        ].join("\n"),
        header: "Unique constraint violation",
        id: "lunora-runtime-unique",
        test: (message) => message.includes("unique constraint violation on"),
    },
    {
        body: ERROR_CATALOG.CONFLICT.hint.join("\n"),
        header: "Optimistic concurrency conflict",
        id: "lunora-runtime-occ",
        test: (message) => message.includes("optimistic concurrency conflict"),
    },
];

/**
 * One documented Cloudflare **platform** error — an edge/origin (5xx) or
 * Cloudflare-service (1xxx) failure surfaced in an error *message* rather than
 * thrown by Lunora as a coded `LunoraError`. These reach a Lunora app as
 * plain text: a Worker that fetches a Cloudflare-fronted origin sees `Error 522`,
 * a deploy that throws surfaces as `Error 1101`, and so on. The fields are the
 * curated facts a grounded explainer elaborates on — never invents beyond.
 */
export interface CloudflarePlatformError {
    /** Documented likely causes (a short, comma-joined clause). */
    causes: string;
    /** The numeric Cloudflare error code, as it appears in the message (e.g. `"522"`, `"1101"`). */
    code: string;
    /** Canonical Cloudflare support-docs URL for this error's family. */
    docsUrl: string;
    /** Which docs family the code belongs to — shown in the "see docs" line. */
    family: "1xxx" | "5xx";
    /** The documented remediation. */
    fix: string;
    /** One-line summary of what the code means. */
    summary: string;
    /** Cloudflare's short name for the code (e.g. `"Connection timed out"`). */
    title: string;
}

/**
 * The curated Cloudflare platform-error table. Sourced from Cloudflare's official
 * support docs — the codes surfaced to app authors on Workers/DO deployments (the
 * origin-connection 52x family and the Worker/DNS/security 1xxx family). `1101`
 * (a Worker threw) and `1102` (a Worker exceeded CPU) are the most Lunora-relevant.
 */
export const CLOUDFLARE_PLATFORM_ERRORS: ReadonlyArray<CloudflarePlatformError> = [
    {
        causes: "the origin returned an empty, unknown, or malformed response Cloudflare couldn't interpret (often an origin crash or an oversized response header)",
        code: "520",
        docsUrl: CF_5XX_DOCS,
        family: "5xx",
        fix: "check your origin's logs for a crash, ensure it returns a valid HTTP response, and keep response headers under the size limit",
        summary: "Cloudflare got an unknown/empty response from your origin web server.",
        title: "Web server returns an unknown error",
    },
    {
        causes: "the origin refused the connection — the web server is down, or a firewall is blocking Cloudflare's IP ranges",
        code: "521",
        docsUrl: CF_5XX_DOCS,
        family: "5xx",
        fix: "confirm the origin process is running and allowlist Cloudflare's published IP ranges in your firewall/security groups",
        summary: "Cloudflare could not connect to your origin because it refused the connection.",
        title: "Web server is down",
    },
    {
        causes: "Cloudflare could not establish a TCP connection to the origin in time — the origin is overloaded, a firewall is dropping packets, or the origin IP is wrong",
        code: "522",
        docsUrl: CF_5XX_DOCS,
        family: "5xx",
        fix: "verify the origin is reachable and not overloaded, and that the DNS record points at the correct origin IP",
        summary: "The connection to your origin timed out before it was established.",
        title: "Connection timed out",
    },
    {
        causes: "Cloudflare cannot route to the origin at all — a bad DNS record, an origin IP that changed, or invalid routing",
        code: "523",
        docsUrl: CF_5XX_DOCS,
        family: "5xx",
        fix: "verify the DNS A/AAAA record points at a reachable origin IP and that no upstream network is blocking Cloudflare",
        summary: "Cloudflare could not reach your origin server.",
        title: "Origin is unreachable",
    },
    {
        causes: "Cloudflare made a TCP connection but the origin did not return an HTTP response within 100 seconds — a slow handler or long-running request",
        code: "524",
        docsUrl: CF_5XX_DOCS,
        family: "5xx",
        fix: "speed up the slow origin handler, or move long work off the request path into a background job (a Durable Object, Queue, or Workflow)",
        summary: "Cloudflare connected to your origin but it did not respond in time.",
        title: "A timeout occurred",
    },
    {
        causes: "the TLS handshake between Cloudflare and the origin failed — a missing/invalid origin certificate, or a cipher/SNI mismatch under Full (Strict) SSL",
        code: "525",
        docsUrl: CF_5XX_DOCS,
        family: "5xx",
        fix: "install a valid certificate on the origin and align your Cloudflare SSL/TLS mode with the origin's certificate setup",
        summary: "The SSL handshake with your origin failed.",
        title: "SSL handshake failed",
    },
    {
        causes: "Cloudflare could not validate the origin's certificate under Full (Strict) SSL — it is expired, self-signed, or issued for the wrong hostname",
        code: "526",
        docsUrl: CF_5XX_DOCS,
        family: "5xx",
        fix: "install a valid, publicly-trusted certificate on the origin (or use a Cloudflare Origin CA cert), matching the request hostname",
        summary: "Cloudflare could not validate your origin's SSL certificate.",
        title: "Invalid SSL certificate",
    },
    {
        causes: "a DNS record points at a Cloudflare IP or another prohibited address instead of your real origin",
        code: "1000",
        docsUrl: CF_1XXX_DOCS,
        family: "1xxx",
        fix: "point the DNS record at your real origin IP, not a Cloudflare-owned or loopback address",
        summary: "DNS points to a prohibited IP.",
        title: "DNS points to prohibited IP",
    },
    {
        causes: "Cloudflare could not resolve the requested hostname — a Worker fetched an unresolvable host, or a DNS record is misconfigured",
        code: "1001",
        docsUrl: CF_1XXX_DOCS,
        family: "1xxx",
        fix: "check the hostname you're requesting and the DNS records for the zone resolve to a valid origin",
        summary: "Cloudflare could not resolve the origin DNS.",
        title: "DNS resolution error",
    },
    {
        causes: "a Worker or DNS record targets a restricted IP (for example a Cloudflare-owned or loopback address)",
        code: "1002",
        docsUrl: CF_1XXX_DOCS,
        family: "1xxx",
        fix: "change the Worker fetch target or DNS record to a valid, non-restricted origin address",
        summary: "DNS points to a prohibited IP (Worker/restricted).",
        title: "DNS points to a prohibited IP",
    },
    {
        causes: "the visitor's IP was blocked by an IP Access Rule, WAF rule, or security configuration on the zone",
        code: "1006",
        docsUrl: CF_1XXX_DOCS,
        family: "1xxx",
        fix: "review the zone's Firewall/WAF and IP Access Rules to see why the address was banned, and adjust if it was blocked in error",
        summary: "Access denied: the visitor's IP has been banned.",
        title: "Access denied: your IP has been banned",
    },
    {
        causes: "your Worker threw an unhandled JavaScript exception during the request",
        code: "1101",
        docsUrl: CF_1XXX_DOCS,
        family: "1xxx",
        fix: "reproduce with `wrangler tail` (or the Workers Logs / Studio Logs panel) to get the stack trace, then handle the throwing code path",
        summary: "A Worker threw a JavaScript exception.",
        title: "Worker threw a JavaScript exception",
    },
    {
        causes: "the Worker used more CPU time than a single invocation is allowed — usually a hot loop or heavy synchronous work",
        code: "1102",
        docsUrl: CF_1XXX_DOCS,
        family: "1xxx",
        fix: "reduce per-request CPU (optimize hot loops, avoid heavy synchronous work) or offload the heavy work to a Durable Object, Queue, or Workflow",
        summary: "A Worker exceeded its CPU-time resource limit.",
        title: "Worker exceeded resource limits",
    },
];

/** True when `character` is an ASCII digit — the token boundary both matchers below test. */
const isDigit = (character: string | undefined): boolean => character !== undefined && character >= "0" && character <= "9";

/**
 * True when `code` appears in `haystack` as a standalone numeric token (not part
 * of a longer number like `5200` or a version `1.1011`). A boundary-checked
 * `indexOf` scan rather than a `RegExp` so no per-code pattern is constructed
 * from a (here trusted, but conventionally avoided) dynamic string.
 */
const hasStandaloneNumber = (haystack: string, code: string): boolean => {
    for (let from = haystack.indexOf(code); from !== -1; from = haystack.indexOf(code, from + code.length)) {
        if (!isDigit(haystack[from - 1]) && !isDigit(haystack[from + code.length])) {
            return true;
        }
    }

    return false;
};

/**
 * True when `haystack` carries Cloudflare's own `Error <code>` / `Error: <code>`
 * phrasing for `code`, with `code` a whole token.
 *
 * The trailing-digit check matters as much here as in the loose matcher. Without
 * it a plain `includes` matches a longer number by prefix, and the two most common
 * socket errors in the wild collide with real Cloudflare codes: `"Error 10061:
 * connect ECONNREFUSED"` (WSAECONNREFUSED) resolved to `1006` — "your IP has been
 * banned" — and `"Error 10060"` (WSAETIMEDOUT) did the same. The wrong hint then
 * became the wrong grounding facts in the explainer prompt.
 */
const hasCodePhrase = (haystack: string, code: string): boolean => {
    for (const phrase of [`error ${code}`, `error: ${code}`]) {
        for (let from = haystack.indexOf(phrase); from !== -1; from = haystack.indexOf(phrase, from + phrase.length)) {
            if (!isDigit(haystack[from + phrase.length])) {
                return true;
            }
        }
    }

    return false;
};

/**
 * Pre-filter over the RAW message, matching what both passes below require. Its
 * only job is speed: it lets a non-matching message skip the `toLowerCase()`
 * allocation as well as the scans. This table is a fallback on `resolveHint`, so
 * the overwhelmingly common call is a message that matches nothing — scanning it
 * unconditionally regressed the `unmatched message (worst case)` benchmark ~1.7x.
 */
const CF_PLATFORM_PREFILTER = /error|cloudflare/iu;

/** Render one {@link CloudflarePlatformError} as the {@link Solution} the CLI and the Issue explainer ground in. */
const cloudflarePlatformSolution = (entry: CloudflarePlatformError): Solution => {
    return {
        body: [
            entry.summary,
            "",
            `**Likely cause:** ${entry.causes}.`,
            "",
            `**Fix:** ${entry.fix}.`,
            "",
            `See [Cloudflare's ${entry.family} error docs](${entry.docsUrl}).`,
        ].join("\n"),
        header: `Cloudflare Error ${entry.code}: ${entry.title}`,
        id: `cloudflare-error-${entry.code}`,
    };
};

/**
 * Recognize a Cloudflare platform-error {@link CloudflarePlatformError} in a raw
 * error message, conservatively: the message must carry Cloudflare's own
 * `Error <code>` phrasing, or mention `cloudflare` alongside the standalone
 * code. That keeps a bare number (`expected 520 items`) from false-matching a 5xx
 * code, at the cost of missing a context-free code — the safe trade for a
 * grounded hint. Returns the matched code's {@link Solution}, or `undefined`.
 *
 * Matching runs in two passes, strongest first: Cloudflare's own `Error <code>`
 * phrasing is unambiguous, so it must win over the weaker "mentions cloudflare
 * near some number" heuristic regardless of table order. A single pass let a weak
 * match on an earlier entry beat an explicit match on a later one — `"Cloudflare
 * Error 1102: exceeded after 524 ms"` resolved to 524, and that wrong grounded
 * fix is exactly what the explainer prompt is built from.
 */
export const findCloudflarePlatformSolution = (message: string): Solution | undefined => {
    // A message carrying neither word cannot match any code — bail before both
    // the lowercasing and the per-entry scans.
    if (!CF_PLATFORM_PREFILTER.test(message)) {
        return undefined;
    }

    const lower = message.toLowerCase();
    const mentionsError = lower.includes("error");
    const mentionsCloudflare = lower.includes("cloudflare");

    // Pass 1 — Cloudflare's own `Error <code>` phrasing is unambiguous.
    if (mentionsError) {
        for (const entry of CLOUDFLARE_PLATFORM_ERRORS) {
            if (hasCodePhrase(lower, entry.code)) {
                return cloudflarePlatformSolution(entry);
            }
        }
    }

    // Pass 2 — the weaker "mentions cloudflare + a standalone code" heuristic.
    if (mentionsCloudflare) {
        for (const entry of CLOUDFLARE_PLATFORM_ERRORS) {
            if (hasStandaloneNumber(lower, entry.code)) {
                return cloudflarePlatformSolution(entry);
            }
        }
    }

    return undefined;
};

/**
 * Flatten a Markdown hint to plain text for a terminal / non-Markdown surface:
 * drop code-fence markers and strip inline `**bold**` / `` `code` `` emphasis.
 * Shared by the CLI renderer and the Studio `ErrorAlert` so the two can't drift.
 */
export const flattenHint = (hint: ErrorHint): string =>
    (typeof hint === "string" ? hint : hint.join("\n"))
        .split("\n")
        .filter((line) => !line.startsWith("```"))
        .join("\n")
        .replaceAll(/\*\*(.+?)\*\*/gu, "$1")
        .replaceAll(/`([^`]+)`/gu, "$1");

/**
 * Find the first message-matched {@link Solution} for `message`, or `undefined`
 * if none recognize it. Re-exported by `@lunora/codegen` as `findLunoraSolution`.
 */
export const findSolutionByMessage = (message: string): Solution | undefined => {
    for (const rule of MESSAGE_SOLUTIONS) {
        if (rule.test(message)) {
            return { body: rule.body, header: rule.header, id: rule.id };
        }
    }

    return undefined;
};

/**
 * Find a solution for `message` across BOTH Lunora's own rules and the curated
 * Cloudflare platform-error table — the lookup the Studio Issues panel and the
 * `explainIssue` grounding use.
 *
 * Deliberately separate from {@link findSolutionByMessage} rather than folded into
 * it. That function is on `resolveHint`, and therefore on `toErrorBody` — the
 * envelope builder for every failed request. Most `ERROR_CATALOG` entries
 * carry no `hint`, so folding the platform table in there meant an ordinary
 * `BAD_REQUEST` whose message merely mentioned "cloudflare" near a number shipped
 * zone-configuration guidance ("review the zone's Firewall/WAF and IP Access
 * Rules") to unauthenticated browsers. The same fold put the table on the CLI
 * renderer and the Vite overlay, and on `toErrorBody`'s hot path.
 *
 * Platform errors are operator-facing context for an already-persisted Issue, so
 * the operator-facing surfaces opt in here and the wire path stays Lunora-only.
 */
export const findIssueSolution = (message: string): Solution | undefined => findSolutionByMessage(message) ?? findCloudflarePlatformSolution(message);

/**
 * Resolve an actionable hint for an error: prefer a hint carried on the error
 * (or its `code`'s catalog entry), then fall back to a message match. Returns
 * `undefined` when nothing recognizes it.
 */
// eslint-disable-next-line sonarjs/function-return-type -- ErrorHint is intentionally `string | string[]`
export const resolveHint = (input: { code?: string; hint?: ErrorHint; message?: string } | string): ErrorHint | undefined => {
    if (typeof input === "string") {
        return findSolutionByMessage(input)?.body;
    }

    if (input.hint !== undefined) {
        return input.hint;
    }

    if (input.code !== undefined) {
        const entry: ErrorCatalogEntry | undefined = getCatalogEntry(input.code);

        if (entry?.hint !== undefined) {
            return entry.hint;
        }
    }

    return input.message === undefined ? undefined : findSolutionByMessage(input.message)?.body;
};
