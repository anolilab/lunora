/**
 * The central Lunora error catalog — the single source of truth mapping a
 * machine-readable `code` to its transport `status`, a short human `title`,
 * and whether its message is redacted on the wire.
 *
 * Only what every runtime needs lives here: the browser client derives its code
 * set from this table and `LunoraError` reads its status from it, so it ships in
 * every client bundle. The actionable Markdown fix per code, and the
 * message-matched solution tables, live in `hints.ts`, which only server-side
 * renderers (the envelope builder, CLI, overlay, MCP, Studio) import.
 */

/* eslint-disable import/exports-last -- a data + types module: the public error-code types are declared next to the catalog they describe; grouping all exports at the end would scatter the taxonomy. */

/** A catalog entry: the fixed metadata for one error `code`. */
export interface ErrorCatalogEntry {
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
    DELIVERY_FENCED: {
        status: 409,
        title: "Delivery authorization changed",
    },

    DELIVERY_RECEIPT_FENCED: {
        status: 409,
        title: "Committed receipt authorization changed",
    },

    CONFLICT: {
        status: 409,
        title: "Conflict",
    },
    NOT_UNIQUE: {
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
        status: 403,
        title: "RLS policy required",
    },

    RUN_DEPTH_EXCEEDED: { internal: true, status: 500, title: "Run depth exceeded" },

    /**
     * A `query` context reached for `ctx.runMutation` / `ctx.runAction`. The
     * generated context object installs all three `run*` methods on every kind, so
     * the TYPE is the only thing that stops a read-only handler from writing — and
     * a cast walks straight past it, inside a subscription re-run that may execute
     * many times per write. Deliberately NOT `internal`: the message names the
     * function that was reached for, and it is a programming error the developer
     * needs to read.
     */
    RUN_KIND_FORBIDDEN: { status: 500, title: "Function kind may not be composed from a query" },
    TRANSACTION_LIMIT_EXCEEDED: {
        status: 413,
        title: "Transaction limit exceeded",
    },
    MIGRATION_NOT_FOUND: { status: 404, title: "Data migration not found" },
    /** `@lunora/d1`'s `MigrationRunner` refused to run: an applied migration's SQL changed, or the tracking table cannot say which migrations already ran. */
    MIGRATION_DRIFT: {
        status: 409,
        title: "Migration drift",
    },
    /** A UNIQUE index cannot be built because existing rows already share its key. The shard refuses user traffic until a later build succeeds. */
    UNIQUE_INDEX_DUPLICATES: {
        hint: [
            "The index was not built, so the shard refuses user traffic until it is.",
            "",
            "Write a `defineMigration` in `lunora/migrations.ts` that deletes or merges the duplicate rows so one row keeps each key. Deploy it, then run `lunora migrate up`. The shard retries the index build on its own, so no second deploy is needed. The `lunora-migration-helper` skill covers the pattern.",
        ],
        status: 409,
        title: "Unique index blocked by duplicate rows",
    },
    UNKNOWN_TABLE: { status: 404, title: "Unknown table" },
    GLOBAL_TABLE_NOT_EDITABLE: { status: 400, title: "Global table is not editable" },

    SHARD_ERROR: { status: 503, title: "Shard error" },
    SHARD_UNAVAILABLE: { status: 503, title: "Shard unavailable" },
    /** A fan-out shard call exceeded the coordinator's per-shard deadline. */
    SHARD_TIMEOUT: { status: 504, title: "Shard timeout" },
    /** A fan-out shard call answered with a non-2xx status; the status is in the message, the body is not. */
    SHARD_HTTP_ERROR: { status: 502, title: "Shard HTTP error" },
    /** A shard running an older build cannot check import rows without writing them, so the dry run was refused before sending any. */
    SHARD_DRY_RUN_UNSUPPORTED: { status: 501, title: "Shard cannot dry-run an import" },
    /** The shard could not write a subscription's attachment to storage, so the subscription was refused. */
    SUBSCRIPTION_PERSIST_FAILED: { status: 500, title: "Subscription persist failed" },
    /** A connection asked for more concurrent subscriptions than the shard allows. */
    TOO_MANY_SUBSCRIPTIONS: { status: 429, title: "Too many subscriptions" },
    /** A live control call arrived after a later one for the same key had already applied. */
    LIVE_CONTROL_SUPERSEDED: { status: 409, title: "A later live control call already applied" },
    OFFLINE_IDENTITY_CHANGED: { status: 409, title: "Offline identity changed" },

    /**
     * A mutation sent with `onlineOnly: true` found its connection not live, so it
     * was refused rather than queued. Nothing was persisted or replayed: to retry,
     * the caller issues the call again once the connection is back.
     */
    OFFLINE_NOT_QUEUED: {
        status: 503,
        title: "Offline, write not queued",
    },
    /** A replayed write named, in `x-lunora-expect-subject`, a different user than the request resolved to. */
    IDENTITY_MISMATCH: {
        status: 409,
        title: "Session changed since the write was queued",
    },

    /** Package-specific codes. Build-time-only — never cross the RPC wire, so deliberately not `internal`. */
    CODEGEN_DIAGNOSTIC: { status: 500, title: "Codegen diagnostic" },
    /** Build-time-only (codegen): `.jurisdiction()` would move DO-backed auth to a new, empty object without `{ pinAuth: true }`. */
    JURISDICTION_MOVE: {
        status: 422,
        title: "Unacknowledged jurisdiction move",
    },
    /** Schema-time only (`defineSchema`): an index names a dotted path. Never crosses the RPC wire. */
    INDEX_FIELD_NESTED_PATH: { status: 500, title: "Index field is a nested path" },
    /** Build-time-only — never crosses the RPC wire, so deliberately not `internal`. */
    SCHEMA_SNAPSHOT_PARSE: { status: 500, title: "Schema snapshot parse error" },
    /** Runtime-reachable (env.ts): message enumerates failing env key names — redact on the wire. */
    ENV_INVALID: { internal: true, status: 500, title: "Invalid environment" },
    /** Runtime-reachable (`@lunora/x402` charge middleware): the facilitator failed to verify or settle; its message carries upstream detail — redact on the wire. */
    X402_FACILITATOR_ERROR: { internal: true, status: 502, title: "Payment facilitator error" },
    /** Runtime-reachable (auth/middleware.ts): message carries auth-wiring guidance — redact on the wire. */
    AUTH_HEADERS_MISSING: { internal: true, status: 500, title: "Auth headers missing" },

    /** `@lunora/privacy`: a request's coverage check found a table that no dataset or exclusion declares. Build- and test-time; the message names the table. */
    PRIVACY_COVERAGE: { status: 500, title: "Privacy coverage check failed" },
    /** `@lunora/privacy`: the subject already has an open request of this type. */
    PRIVACY_REQUEST_OPEN: { status: 409, title: "A privacy request is already open" },
    /** `@lunora/privacy`: an erasure needs a recent sign-in, the same window account deletion uses. */
    PRIVACY_SESSION_NOT_FRESH: { status: 403, title: "Recent sign-in required" },

    /**
     * Signup rejected by `@lunora/auth`'s email-domain gate — a disposable/throwaway
     * provider (or a caller deny-list hit). Client-safe: the message names only the
     * offending domain class, never a secret, so it is echoed rather than redacted.
     */
    EMAIL_DOMAIN_BLOCKED: {
        status: 400,
        title: "Email domain not allowed",
    },

    /**
     * Opt-in MX verification (`@lunora/auth/email-guard`, `mx: true`) found no mail
     * exchanger for the address's domain, so mail to it would never deliver.
     * Client-safe: names only the domain, no secret.
     */
    EMAIL_UNDELIVERABLE: {
        status: 400,
        title: "Email domain cannot receive mail",
    },

    /**
     * Upstream Cloudflare API failures surfaced from an action. The message
     * carries the upstream response body (Cloudflare's own error text — trusted
     * infra, not user input), so it is echoed rather than redacted. `status`
     * here is a fallback; each throw passes the actual upstream HTTP status.
     */
    /*
     * `ctx.analyticsSql` (`@lunora/bindings/analytics-sql`): a rejected Analytics
     * SQL query from the binding or its REST transport. `data.retryable` says
     * whether repeating it may succeed; the message carries a capped preview.
     */
    ANALYTICS_SQL_QUERY_ERROR: { status: 502, title: "Analytics SQL query error" },
    BROWSER_RUN_ERROR: { status: 502, title: "Browser Run API error" },
    /** A navigation's redirect chain passed the SSRF guard's hop cap (`@lunora/browser`). */
    BROWSER_TOO_MANY_REDIRECTS: { status: 502, title: "Too many redirects" },
    R2_SQL_ERROR: { status: 502, title: "R2 SQL API error" },
    WORKFLOWS_REST_ERROR: { status: 502, title: "Cloudflare Workflows REST API error" },

    /*
     * `@lunora/payment` codes, minted through `LunoraPaymentError` — a
     * `LunoraError` subclass. They shipped uncatalogued because the
     * registration gate's scanner only matched the literal `new LunoraError(`,
     * so every subclass mint was invisible to it and `isInternalCode` (which
     * fails OPEN) classed all six as client-safe. `status` mirrors the
     * package's own `STATUS_BY_CODE`. The remaining payment codes — `FORBIDDEN`,
     * `INVALID_TRANSITION`, `NOT_FOUND`, `VALIDATION_ERROR` — are the generic
     * entries above and keep their existing verdicts.
     *
     * `CONFIG_INVALID` is `internal` because its messages name server wiring
     * ("webhook secret not configured", a duplicate/absent adapter), and the
     * caller can do nothing with them. That verdict only holds while the code
     * is reserved for server configuration: `check()`'s argument-shape guard
     * used to mint it for "requires a featureId or priceId", which is the
     * caller's own mistake and now mints `VALIDATION_ERROR` instead. Keep new
     * caller-fixable failures off this code rather than widening it.
     */

    /** Server-side payment wiring is wrong or missing (`webhook secret not configured`, a duplicate/absent adapter). A 500 that names internal configuration — redact on the wire. */
    CONFIG_INVALID: { internal: true, status: 500, title: "Payment configuration invalid" },
    /** Arithmetic across two currencies. The message names only the two currency codes the caller supplied. */
    CURRENCY_MISMATCH: { status: 400, title: "Currency mismatch" },

    /**
     * A payment provider refused or answered unusably. NOT `internal`, matching
     * the upstream-API 502s above: the messages are fixed capability text
     * ("<provider> does not support refundPayment") or echo back the malformed
     * id the CALLER passed in, so none of them reveals state the caller did not
     * already have.
     */
    PROVIDER_ERROR: { status: 502, title: "Payment provider error" },

    /**
     * Webhook rejections, addressed to the provider posting the hook, so NOT
     * `internal`. Five of the six mint sites are fixed strings ("no matching
     * signature", "missing creem-signature header"). The sixth,
     * `providers/stripe.ts`, passes the Stripe SDK's own verification message
     * through — "No signatures found matching…", "Timestamp outside the
     * tolerance zone" — which still describes the REQUEST the poster sent, not
     * this server's state. Keep that true of anything added here: an upstream
     * message is only safe to forward while it is about the caller's input.
     */
    WEBHOOK_EVENT_ID_MISSING: { status: 400, title: "Webhook event id missing" },
    WEBHOOK_SIGNATURE_INVALID: { status: 400, title: "Webhook signature invalid" },
    WEBHOOK_TIMESTAMP_INVALID: { status: 400, title: "Webhook timestamp outside tolerance" },

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

    /**
     * Deliberately NOT `internal`, unlike its 500 neighbours: the message is
     * fixed configuration guidance that names no table, path or identifier, and
     * redacting it to "Internal error" would strip the only thing this code
     * exists to deliver. It is raised before any query runs, so there is no
     * backend detail to leak.
     */
    AUTH_MIGRATOR_UNSUPPORTED: {
        status: 500,
        title: "Auth migrator cannot drive the configured database",
    },
    AUTH_NOT_CONFIGURED: { status: 400, title: "Auth admin not configured" },
    AUTH_OP_NOT_SUPPORTED: { status: 400, title: "Auth admin operation not supported" },

    /**
     * MCP OAuth wiring mistakes, raised while the auth instance or MCP route is
     * built (plan 461). Not `internal`, for the same reason as the auth migrator
     * entry above: the message is fixed configuration guidance (at most echoing
     * the app's own configured `resource` value), raised before any request is
     * served, so it carries no backend detail and redacting it would hide the fix.
     */
    AUTH_CIMD_FETCH_NOT_PUBLIC: {
        status: 500,
        title: "CIMD transport needs the global_fetch_strictly_public flag",
    },
    AUTH_MCP_RESOURCE_AMBIGUOUS: {
        status: 500,
        title: "MCP resource cannot be told apart from the provider's other resources",
    },
    AUTH_MCP_RESOURCE_INVALID: {
        status: 500,
        title: "MCP resource missing or not an absolute URL",
    },
    MCP_STEP_UP_MISCONFIGURED: {
        status: 500,
        title: "MCP step-up misconfigured",
    },
    BACKUP_NOT_CONFIGURED: { status: 500, title: "Scheduled backup not configured" },
    BACKUP_RETENTION_NOT_CONFIGURED: {
        status: 400,
        title: "Backup retention window not configured",
    },
    BACKUP_TOO_LARGE: {
        status: 507,
        title: "Backup too large to assemble in a Worker",
    },
    CRON_JOBS_NOT_CONFIGURED: { status: 400, title: "Cron jobs not configured" },
    CRON_JOB_NOT_FOUND: { status: 404, title: "Cron job not found" },
    EXPORT_SHARD_FAILED: {
        status: 502,
        title: "Export failed on one or more shards",
    },
    EXPORT_TAP_NOT_CONFIGURED: { status: 400, title: "Export tap not configured" },
    FUNCTIONS_NOT_CONFIGURED: { status: 400, title: "Functions registry not configured" },
    GLOBALS_NOT_CONFIGURED: { status: 400, title: "Global-table introspector not configured" },
    ID_COLLISION: {
        status: 409,
        title: "Document id already belongs to another table",
    },
    KV_NOT_CONFIGURED: { status: 400, title: "KV introspector not configured" },
    MIGRATION_ID_REQUIRED: { status: 400, title: "Migration id required" },
    PITR_UNAVAILABLE: { status: 409, title: "Point-in-time recovery unavailable" },
    SCHEDULER_NOT_CONFIGURED: { status: 400, title: "Scheduler not configured" },
    STORAGE_CHECKSUM_MISMATCH: {
        status: 400,
        title: "Storage checksum mismatch",
    },
    STORAGE_DELETE_NOT_CONFIGURED: { status: 400, title: "Storage delete not configured" },
    STORAGE_DOWNLOAD_NOT_CONFIGURED: {
        status: 400,
        title: "Storage download not configured",
    },
    STORAGE_NOT_CONFIGURED: { status: 400, title: "Storage not configured" },
    STORAGE_OBJECT_NOT_FOUND: { status: 404, title: "Storage object not found" },
    STORAGE_UPLOAD_NOT_CONFIGURED: { status: 400, title: "Storage upload not configured" },
    STORAGE_URL_NOT_CONFIGURED: { status: 400, title: "Storage signed URL not configured" },
    AI_UNKNOWN_IMAGE_MODEL: { status: 400, title: "Unknown image model" },
    RAG_DIMENSION_MISMATCH: {
        status: 409,
        title: "Embedding dimension mismatch",
    },
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

    /** Copying DO-backed auth into its jurisdiction-pinned object (`__lunora_admin__:copyAuthToJurisdiction` / `purgeUnpinnedAuth`). */
    AUTH_MOVE_NOT_CONFIGURED: {
        status: 400,
        title: "Auth jurisdiction move not configured",
    },
    AUTH_MOVE_TARGET_NOT_EMPTY: {
        status: 409,
        title: "Pinned auth object is not empty",
    },
    AUTH_MOVE_CONFLICT: {
        status: 409,
        title: "Auth copy conflict",
    },
    AUTH_MOVE_SOURCE_CHANGED: {
        status: 409,
        title: "Un-pinned auth object changed since the copy",
    },
    AUTH_MOVE_SOURCE_PURGED: {
        status: 409,
        title: "Un-pinned auth object already purged",
    },
    AUTH_MOVE_INCOMPLETE: {
        status: 409,
        title: "Auth copy not finished",
    },

    /**
     * A move step failed inside an auth object. Not `internal`: the message is built by
     * the object from the step, the table and a SQLite error class, never row data, so
     * the admin caller sees why; the object logs the full error.
     */
    AUTH_MOVE_FAILED: {
        status: 500,
        title: "Auth jurisdiction move failed",
    },

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
    DUPLICATE_AGENT_CLASS: { status: 500, title: "Duplicate agent generated class name" },
    DUPLICATE_AGENT_NAME: { status: 500, title: "Duplicate agent name" },
    DUPLICATE_MIGRATION_ID: { status: 500, title: "Duplicate migration id" },
    DUPLICATE_QUEUE_BINDING: { status: 500, title: "Duplicate queue binding" },
    DUPLICATE_QUEUE_NAME: { status: 500, title: "Duplicate queue name" },
    DUPLICATE_ROOM_NAME: { status: 500, title: "Duplicate room name" },
    ROOM_NAME_NOT_LITERAL: { status: 500, title: "Room name is not a string literal" },
    DUPLICATE_SOCKET_PATH: { status: 500, title: "Duplicate socket route path" },
    SOCKET_AUTH_NOT_LITERAL: { status: 500, title: "Socket route auth is not a literal boolean" },
    SOCKET_PATH_INVALID: { status: 500, title: "Socket route path is not a plain URL path" },
    SOCKET_PATH_NOT_LITERAL: { status: 500, title: "Socket route path is not a string literal" },
    LIVE_STREAM_DUPLICATE: { status: 500, title: "Duplicate live stream id or export name" },
    LIVE_STREAM_NOT_EXPORTED: { status: 500, title: "Live stream is not a named export" },
    LIVE_STREAM_NOT_LITERAL: { status: 500, title: "Live stream declaration is not a literal" },
    LIVE_TOPIC_INVALID: { status: 500, title: "Live topic name or key field is not allowed" },
    DUPLICATE_WORKFLOW_CLASS: { status: 500, title: "Duplicate workflow generated class name" },
    WORKFLOW_EVENT_DUPLICATE: { status: 500, title: "Duplicate workflow event type" },
    WORKFLOW_EVENT_NOT_LITERAL: { status: 500, title: "Workflow event type is not a string literal" },
    MIGRATION_ID_NOT_STATIC: { status: 500, title: "Migration id is not statically analyzable" },
    NAMESPACE_COLLISION: { status: 500, title: "Function namespace collision" },

    /**
     * `@lunora/runtime`'s dispatch/security-boundary codes — RPC/HTTP entry, not
     * admin-gated. Fixed, non-sensitive messages throughout, so none are `internal`.
     */
    BAD_ROW: { status: 400, title: "Malformed import row" },
    BAD_SUBSCRIPTION_ARGS: { status: 400, title: "Invalid subscription arguments" },
    BATCH_LIMIT_EXCEEDED: { status: 400, title: "Batch limit exceeded" },
    /** An `onDelete` cascade / `set null` would touch more holder rows than one delete may (`CASCADE_MAX_ROWS` in `@lunora/shard-engine`). */
    CASCADE_LIMIT: { status: 400, title: "Cascade limit exceeded" },
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
        status: 403,
        title: "Dispatch caller not authenticated",
    },

    /**
     * A dispatch arrived carrying an `x-lunora-mutation-id` whose handler is
     * ALREADY executing in the shard, on the ungated (non-mutation) path where
     * nothing serialises the two. The shard declines the second delivery rather
     * than running it alongside the first.
     *
     * Deliberately a `409` and deliberately NOT one of `@lunora/dispatch`'s
     * `DETERMINISTIC_DISPATCH_STATUSES`: the refusal is about WHEN the request
     * arrived, not about the request. It clears on its own the moment the first
     * attempt settles — at which point the same id replays into the dedup row
     * and is served its cached result — so every caller (the scheduler's retry
     * ladder, a queue consumer, a workflow step) must keep retrying it.
     */
    DISPATCH_IN_PROGRESS: {
        status: 409,
        title: "Dispatch already in progress",
    },
    /** A socket re-auth carried a credential older than the one the socket already holds; the socket keeps its newer one. */
    STALE_CREDENTIAL: { status: 409, title: "Stale credential" },
    /** A socket re-auth resolved to different claims than the socket was opened with; the client must reconnect to change identity. */
    IDENTITY_CHANGED: { status: 409, title: "Socket identity changed" },
    FORBIDDEN_FANOUT: { status: 403, title: "Fan-out forbidden" },
    GLOBAL_SEARCH_SCORES_UNSUPPORTED: { status: 400, title: "collectWithScores() is unsupported on a global table" },
    FORBIDDEN_ORIGIN: { status: 403, title: "Origin forbidden" },
    FORBIDDEN_SHARD: { status: 403, title: "Shard access forbidden" },
    FORBIDDEN_TOPIC: { status: 403, title: "Live topic publish forbidden" },
    GLOBAL_DRY_RUN_UNSUPPORTED: { status: 400, title: "Global table dry run not supported" },
    GLOBAL_NOT_CONFIGURED: { status: 400, title: "Global table import not configured" },
    INVALID_INPUT: { status: 400, title: "Invalid input" },
    /** A caller-supplied `RunOptions.id` that is not a safe key segment. NOT internal: the message is fixed guidance about the caller's own argument, and withholding it would leave them guessing at a 400. */
    INVALID_SCHEDULE_ID: { status: 400, title: "Invalid schedule id" },
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

    /**
     * A shard-local shape's predicate filters by a relation. The shape's seed and membership probe read its own table
     * only, so the relation would never match and a write to the related table would never move the shape. Refused at
     * subscribe, with the same remedies as `SHAPE_CROSS_SHARD_JOIN`. A `.global()` shape is read through the store's
     * `findMany`, which resolves relations, and is not refused.
     */
    SHAPE_RELATION_PREDICATE: { status: 400, title: "Shape filtered by a relation is unsupported" },
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

    /**
     * A function's RETURN value cannot be carried by the wire codec — a class
     * instance (`Decimal`, an ORM entity, `Temporal.*`, `RegExp`, `Headers`), or
     * nesting past the codec's depth cap.
     *
     * Deliberately NOT `internal`: the message names the offending constructor,
     * which is the caller's own handler code and the only thing that makes the
     * failure actionable. Redacting it leaves a bare 500 with nothing to grep.
     * Raised INSIDE a mutation's transaction, so the writes roll back rather than
     * committing behind a response that then fails to serialize.
     */
    WIRE_ENCODE_FAILED: { status: 500, title: "Could not encode a return value" },
    UNKNOWN_COLUMN: { status: 404, title: "Unknown column" },

    /**
     * `@lunora/do`'s ShardDO — WebSocket-frame codes, changelog-retention refusals
     * and SQLite-in-DO invariants.
     *
     * `NESTED_TRANSACTION` and `SQL_UNAVAILABLE` are "should never happen" state
     * invariants (mirrors `RUN_DEPTH_EXCEEDED`'s posture above): today's message
     * is static and safe, but flagged internal so a future edit that adds
     * diagnostic detail can't accidentally start leaking it. The three `CDC_*`
     * codes are the opposite — ordinary, expected outcomes of a configured
     * retention window or an operator-ordered restore — and all three are `409`
     * because the cursor the caller holds is real but no longer serveable, so
     * the recovery is a snapshot rather than a retry.
     */
    /** A resume below the deleted changelog prefix: the entries are gone outright, for every consumer. */
    CDC_LOG_TRIMMED: { status: 409, title: "CDC log trimmed" },
    /** A resume from ABOVE the changelog's high-watermark: the shard's log rewound (a point-in-time restore), so the cursor indexes a timeline that no longer exists. Carries the surviving cursor and the freshly minted epoch to resynchronise against. */
    CDC_TIMELINE_FORKED: { status: 409, title: "CDC timeline forked" },
    /** A resume below the compacted prefix: the keys survive but their post-images do not, so only a payload consumer (streaming export, replay-PITR, a read replica) is refused. */
    CDC_PAYLOAD_COMPACTED: { status: 409, title: "CDC payloads compacted" },
    EXPIRED: { status: 404, title: "Session expired" },
    LIVE_CONNECTION_LIMIT: { status: 503, title: "Live connection limit reached" },
    LIVE_CONNECTION_NOT_FOUND: { status: 404, title: "Live connection not found" },
    LIVE_STREAMS_UNSUPPORTED: { status: 501, title: "Live streams are not served by this worker" },
    NESTED_TRANSACTION: { internal: true, status: 500, title: "Nested transaction" },
    OUT_OF_ORDER: { status: 409, title: "Out-of-order mutation" },
    SHAPE_GLOBAL_TOO_LARGE: { status: 413, title: "Global shape too large" },
    SHAPE_NOT_FOUND: { status: 404, title: "Shape not found" },
    SHAPE_REQUIRES_CDC: { status: 409, title: "Shape requires change-data-capture" },
    SQL_UNAVAILABLE: { internal: true, status: 500, title: "SQL storage unavailable" },
    STREAM_ID_IN_USE: { status: 409, title: "Stream id already in use" },
    STREAM_IDLE: { status: 504, title: "Stream went idle" },
    STREAM_INTERRUPTED: { status: 503, title: "Durable stream interrupted" },
    STREAM_TOO_LONG: { status: 507, title: "Durable stream exceeded its chunk ceiling" },
    SUBSCRIPTION_RESULT_TOO_LARGE: { status: 413, title: "Subscription result too large" },
    TOKEN_EXPIRED: {
        status: 401,
        title: "Authentication token expired",
    },
    TOO_MANY_LIVE_TOPICS: { status: 429, title: "Too many live topics" },
    TOO_MANY_STREAMS: { status: 429, title: "Too many streams" },

    /**
     * A socket asked an `onWhisper` authorizer to decide more distinct topics
     * than the shard allows. Names only the socket's own ceiling — never the
     * topic, never what the authorizer would have answered — so it is safe on
     * the wire and not `internal`.
     */
    TOO_MANY_WHISPER_TOPICS: {
        status: 429,
        title: "Too many whisper topics",
    },
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
    HTTP_STREAM_CALLBACK: { status: 500, title: "HTTP stream callback threw" },
    HTTP_STREAM_INTERRUPTED: { status: 502, title: "HTTP stream interrupted" },
    HTTP_STREAM_MISSING_PARAM: { status: 400, title: "HTTP stream missing path parameter" },

    /**
     * Fires only for a `fetch` whose Response exposes neither a `body` stream
     * nor a `text()` read — a broken substitute, not a runtime limitation. A
     * body-less response that can still be read as text (React Native's
     * `whatwg-fetch`) never reaches this code: `httpStream` buffers it through
     * `text()` instead.
     */
    HTTP_STREAM_NO_BODY: {
        status: 502,
        title: "HTTP stream response has no body",
    },
    HTTP_STREAM_STATUS: { status: 502, title: "HTTP stream request failed" },
    HTTP_STREAM_TRANSPORT: { status: 502, title: "HTTP stream transport error" },
    STREAM_BACKPRESSURE: { status: 429, title: "Stream backpressure" },
    STREAM_DISCONNECTED: { status: 503, title: "Stream disconnected" },
    STREAM_QUEUE_OVERFLOW: { status: 429, title: "Stream queue overflow" },

    /** `@lunora/db`'s offline outbox: a queued write targeted a collection removed/renamed in a later deploy. */
    UNKNOWN_MUTATION_FN: { status: 404, title: "Unknown mutation function" },

    /**
     * A local tool the CLI shells out to — `wrangler`, `git`, `docker`, a
     * package manager — is not on PATH, so the child process never started.
     *
     * CLI-only and build-time-like: it never crosses the RPC wire (the same
     * posture as `CODEGEN_DIAGNOSTIC`), so it is deliberately not `internal` —
     * the message names the missing command, which IS the fix. The `500` is a
     * placeholder for a transport that never carries it; `@lunora/cli` maps this
     * code to its `missing local dependency` exit code BY NAME, because no HTTP
     * status means "that program isn't installed".
     */
    LOCAL_DEPENDENCY_MISSING: {
        status: 500,
        title: "Required local tool not found",
    },
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
 * `LunoraError` constructor and {@link isInternalCode}.
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
