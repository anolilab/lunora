import type { AdvisorAdminRoute } from "./admin-routes";
import type { AdvisorAiRawRun } from "./ai-raw-runs";
import type { AdvisorAiToolSideEffect } from "./ai-tool-side-effects";
import type { AdvisorArgumentDerivedFetch } from "./argument-derived-fetches";
import type { AdvisorArgumentValidator } from "./argument-validators";
import type { AdvisorAuthConfig } from "./auth-config";
import type { AdvisorAuthApiCall } from "./authapi-calls";
import type { AdvisorBrowserUrlAccess } from "./browser-url-accesses";
import type { AdvisorConfigCall } from "./config-calls";
import type { AdvisorContainerKeyAccess } from "./container-key-accesses";
import type { AdvisorContainerOverride } from "./container-overrides";
import type { AdvisorContainer } from "./containers";
import type { AdvisorExportSink } from "./export-sinks";
import type { AdvisorFailOpenGuard } from "./fail-open-guards";
import type { AdvisorFlagRead } from "./flag-reads";
import type { AdvisorFlagSecurityDefault } from "./flag-security-defaults";
import type { AdvisorGeoIndexUsage } from "./geo-index-usages";
import type { AdvisorHttpActionGuard } from "./http-action-guards";
import type { AdvisorHttpHeaderWrite } from "./http-header-writes";
import type { AdvisorHyperdriveCall } from "./hyperdrive-calls";
import type { AdvisorIdentityClaimRead } from "./identity-claim-reads";
import type { AdvisorImageDeliveryUrlAccess } from "./image-delivery-url-accesses";
import type { AdvisorIndexHit, AdvisorTableScan } from "./index-usage";
import type { AdvisorInsertWrite } from "./inserts";
import type { AdvisorKvKeyAccess } from "./kv-key-accesses";
import type { AdvisorMailRecipientAccess } from "./mail-recipient-accesses";
import type { AdvisorMaskProcedure } from "./mask-procedures";
import type { AdvisorMaskStrategy } from "./mask-strategies";
import type { AdvisorMutatorWrite } from "./mutator-writes";
import type { AdvisorNondeterministicCall } from "./nondeterministic-calls";
import type { AdvisorNormalizeIdAuthorization } from "./normalize-id-authorization";
import type { AdvisorNotifyCall, AdvisorNotifyConfig } from "./notify-calls";
import type { AdvisorOwnerFieldWrite } from "./owner-field-writes";
import type { AdvisorPaymentWebhook } from "./payment-webhooks";
import type { AdvisorPrivilegedDispatch } from "./privileged-dispatches";
import type { AdvisorProcedureProtection } from "./procedure-protections";
import type { AdvisorQueryRead } from "./queries";
import type { AdvisorQueue } from "./queues";
import type { AdvisorR2sqlCall } from "./r2sql-calls";
import type { AdvisorRatelimitKeySelector } from "./ratelimit-key-selectors";
import type { AdvisorRawRowReturn } from "./raw-row-returns";
import type { AdvisorRelationLoad } from "./relation-loads";
import type { AdvisorRlsProcedure } from "./rls-procedures";
import type { AdvisorSchema } from "./schema";
import type { AdvisorSecretLiteral } from "./secrets";
import type { AdvisorShape } from "./shapes";
import type { AdvisorShardTraffic } from "./shard-traffic";
import type { AdvisorSoftDeleteRead } from "./soft-delete-reads";
import type { AdvisorSqlInterpolation } from "./sql-interpolation";
import type { AdvisorStaleMigrationImport } from "./stale-migration-imports";
import type { AdvisorStorageKeyAccess } from "./storage-key-accesses";
import type { AdvisorStorageUpload } from "./storage-uploads";
import type { AdvisorUnrestrictedWhereBranch } from "./unrestricted-where-branches";
import type { AdvisorVectorNamespaceAccess } from "./vector-namespace-accesses";
import type { AdvisorWorkflow, AdvisorWorkflowCall } from "./workflows";
import type { AdvisorWranglerVariable } from "./wrangler-variables";

/**
 * Severity of a finding, mirroring splinter's `level`. `ERROR` is a definite
 * problem, `WARN` a likely one, `INFO` an advisory nudge.
 */
export type Level = "ERROR" | "INFO" | "WARN";

/**
 * Who the finding concerns, mirroring splinter's `facing`. `EXTERNAL` findings
 * affect clients of the app (performance/security a user can feel); `INTERNAL`
 * ones are operator-only hygiene.
 */
export type Facing = "EXTERNAL" | "INTERNAL";

/**
 * Concern bucket a lint belongs to. `SCHEMA` covers shape/correctness nits that
 * are neither a perf nor a security issue (missing primary key, duplicate
 * index). `PERFORMANCE` and `SECURITY` match splinter's two categories.
 */
export type Category = "PERFORMANCE" | "SCHEMA" | "SECURITY";

/**
 * Where a lint draws its evidence from.
 *
 * `static` runs against the declared {@link AdvisorSchema} alone (tables,
 * indexes, relations) — deterministic, runnable at codegen/build time, and
 * catches a problem _before_ it ships. This is the edge Lunora has over a
 * live-DB-only advisor like Supabase's.
 *
 * `runtime` needs observed signal from a running shard (full-scan attribution,
 * function call stats). Added in a later slice; the context grows optional
 * fields the runtime lints read.
 */
export type LintSource = "runtime" | "static";

/**
 * One emitted advisory, shaped after splinter's lint-view row so the studio
 * Advisors table can render any lint uniformly. `cacheKey` is a stable,
 * content-derived id used to dedup across runs and to let an operator dismiss a
 * specific finding without silencing the whole lint.
 */
export interface Finding {
    /** Stable identifier for dedup/dismissal across runs. */
    cacheKey: string;
    /** The lint's concern buckets (usually one). */
    categories: Category[];
    /** Human-readable explanation of the rule in general terms. */
    description: string;
    /** The specific violation message for _this_ occurrence. */
    detail: string;
    /** Who the finding concerns. */
    facing: Facing;
    /** Severity. */
    level: Level;
    /** Structured context (table, field, index, …) for the UI and deep links. */
    metadata: Record<string, unknown>;
    /** The lint id that produced this finding, e.g. `unindexed_foreign_key`. */
    name: string;
    /** How to fix it — a doc URL or short imperative guidance. */
    remediation: string;
    /** Short headline for the finding. */
    title: string;
}

/**
 * Everything a lint may inspect. Static lints read only {@link LintContext.schema};
 * runtime lints will additionally read observed-signal fields added here later.
 */
export interface LintContext {
    /**
     * `httpRoute.<verb>("/admin/…")` routes on admin/privileged-looking paths and
     * whether each references an auth/admin guard — the `admin_route_without_guard`
     * input. Supplied by the codegen feeder; absent for runtime callers, where the
     * lint finds nothing.
     */
    adminRoutes?: ReadonlyArray<AdvisorAdminRoute>;

    /**
     * `ctx.ai.run(model, …)` calls whose model-id argument is derived from the
     * handler's `args` with no server-side scoping — the `ai_raw_run_escape_hatch`
     * input. `ctx.ai.run` is the raw Workers AI passthrough, so an arg-derived model
     * id lets any caller select an arbitrary model, bypassing the typed
     * `ctx.ai.model(...)` + AI-SDK layer's cap/schema (an arg-derived `inputs`
     * argument is normal usage and is not recorded). Supplied by the codegen feeder;
     * absent for runtime callers, where the lint finds nothing.
     */
    aiRawRuns?: ReadonlyArray<AdvisorAiRawRun>;

    /**
     * `generateText` / `streamText` calls whose model-callable `tools` reach a
     * privileged side effect (DB write / function dispatch / outbound
     * fetch/mail/queue) — the `ai_tool_side_effect_prompt_injection` input. Each
     * row's `userInputDerived` says whether the model input flows from `args`; the
     * lint fires only when it does. Supplied by the codegen feeder; absent for
     * runtime callers, where the lint finds nothing.
     */
    aiToolSideEffects?: ReadonlyArray<AdvisorAiToolSideEffect>;

    /**
     * `ctx.fetch(url, …)` calls inside actions whose URL argument is derived from
     * the handler's `args` — the `action_fetch_ssrf` input. `ctx.fetch` has no
     * host allowlist, so a URL built from request input is a server-side request
     * forgery vector. Supplied by the codegen feeder; absent for runtime callers,
     * where the lint finds nothing.
     */
    argumentDerivedFetches?: ReadonlyArray<AdvisorArgumentDerivedFetch>;

    /**
     * Per-public-procedure argument validators that weaken input safety — the
     * `public_arg_uses_any` (`v.any()` args) and `unbounded_string_arg` (length-less
     * `v.string()` args) input. Supplied by the codegen feeder for public procedures
     * only; absent for runtime callers, where the lints find nothing.
     */
    argValidators?: ReadonlyArray<AdvisorArgumentValidator>;

    /**
     * `ctx.authApi.<method>(...)` calls discovered in function bodies (the
     * `auth_api_call_without_headers` input). Supplied by the codegen feeder; absent
     * for runtime callers, where the lint finds nothing.
     */
    authApiCalls?: ReadonlyArray<AdvisorAuthApiCall>;

    /**
     * Per-`createAuth({...})`-call configuration snapshots — the shared input for
     * the five `auth_*` security lints (`auth_trusted_origins_wildcard`,
     * `auth_csrf_check_disabled`, `auth_secure_cookies_disabled`,
     * `auth_email_verification_disabled`, `auth_session_freshage_zero`). Each
     * carries whether the call's config object literal was statically analyzable
     * and, when it was, the handful of nested facts the lints check (a
     * `trustedOrigins` wildcard, `advanced.disableCSRFCheck`/`useSecureCookies`,
     * `emailAndPassword.enabled`/`requireEmailVerification`,
     * `session.freshAge === 0`). Supplied by the codegen feeder; absent for
     * runtime callers, where the auth-config lints find nothing.
     */
    authConfigs?: ReadonlyArray<AdvisorAuthConfig>;

    /**
     * `ctx.browser.<method>(url, …)` calls whose navigation URL is derived from the
     * handler's `args` with no server-side scoping — the
     * `browser_user_url_without_allowlist` input. `@lunora/browser` blocks
     * private/internal targets by default, but a request-supplied public URL can
     * still be an open-proxy / SSRF vector; the lint suppresses findings when a
     * `createBrowser` config-call is hardened with `allowedHosts` or `resolveDns`.
     * Supplied by the codegen feeder; absent for runtime callers, where the lint
     * finds nothing.
     */
    browserUrlAccesses?: ReadonlyArray<AdvisorBrowserUrlAccess>;

    /**
     * Factory/constructor calls in `lunora/` whose config object literal a
     * security lint inspects for a present-or-absent key — the shared input for
     * the config-call security lints (payment authorize, inbound-mail verify,
     * rate-limit store, browser private-targets). Supplied by the codegen feeder;
     * absent for runtime callers, where the config-call lints find nothing.
     */
    configCalls?: ReadonlyArray<AdvisorConfigCall>;

    /**
     * `ctx.containers.<name>.get(key, …)` calls whose instance key is derived from
     * the handler's `args` with no server-side scoping — the
     * `container_instance_key_from_user_input` input. Each container definition's
     * `.get(name)` accessor routes to one instance per key, so an arg-derived key lets
     * any caller reach another tenant's container (cross-tenant IDOR). A key scoped by
     * a server-trusted `ctx.*` value, or a fixed literal, is not recorded. Supplied by
     * the codegen feeder; absent for runtime callers, where the lint finds nothing.
     */
    containerKeyAccesses?: ReadonlyArray<AdvisorContainerKeyAccess>;

    /**
     * Runtime container-override calls — a `.start({ enableInternet: true, … })`
     * launch override, or a `.egress.<method>(...)` runtime firewall mutation — the
     * `container_start_enable_internet_override` and `container_runtime_egress_relaxation`
     * lint input. Supplied by the codegen feeder; absent for runtime callers, where
     * those lints find nothing.
     */
    containerOverrides?: ReadonlyArray<AdvisorContainerOverride>;

    /**
     * Containers declared in `lunora/containers.ts` — the `container_*` lint
     * input. Supplied by the codegen feeder; absent for runtime callers, where
     * the container lints find nothing.
     */
    containers?: ReadonlyArray<AdvisorContainer>;

    /**
     * CDC export-sink constructions (`defineExportSink` / `webhookExportSink` /
     * `r2Sink`) discovered in function bodies — the `export_sink_misconfigured`
     * input. Each carries which config keys were present (and which were an empty
     * string), so the lint can flag a sink missing a required field (a webhook
     * with no `url`, an R2 sink with no `bucket`, a sink with no `name`/`deliver`).
     * Supplied by the codegen feeder; absent for runtime callers, where the lint
     * finds nothing.
     */
    exportSinks?: ReadonlyArray<AdvisorExportSink>;

    /**
     * `rateLimit`/`dbRateLimit` (`@lunora/ratelimit`) and `verifyTurnstileMiddleware`
     * (`@lunora/auth`) middleware calls, each with whether its options literal set
     * `failOpen: true` and the rate-limit `name` — the
     * `ratelimit_middleware_fail_open` input. These guards fail closed by default; a
     * `failOpen: true` admits every request during a limiter/siteverify outage, so
     * the lint fires when a fail-open guard protects an auth/payment-sensitive
     * procedure. Supplied by the codegen feeder; absent for runtime callers, where
     * the lint finds nothing.
     */
    failOpenGuards?: ReadonlyArray<AdvisorFailOpenGuard>;

    /* eslint-disable no-secrets/no-secrets -- the referenced lint rule id in the doc comment, not a credential */

    /**
     * `ctx.flags` reads lexically inside a `query(...)` handler — the
     * `flag_read_in_subscription` input. A flag flip appends nothing to `__cdc_log`,
     * so no live subscription is re-run and the query keeps serving the branch it
     * last picked; `useFlag` is the reactive path. Only `query` handlers are
     * recorded — a `mutation`/`action` runs once, so there is no staleness there.
     * Supplied by the codegen feeder; absent for runtime callers, where the lint
     * finds nothing.
     */
    flagReads?: ReadonlyArray<AdvisorFlagRead>;
    /* eslint-enable no-secrets/no-secrets -- re-enable after the flagReads doc block */

    /**
     * `ctx.flags.boolean(key, default)` reads with a statically-known string key and
     * boolean-literal default — the `flag_gates_security_with_unsafe_default` input.
     * OpenFeature returns the default when the provider errors, so a fail-open
     * default on a security-shaped key (an `enforce`/`rls`/`gate`/`lockdown`
     * protection defaulting `false`, or an `allow`/`permit`/`bypass` permission
     * defaulting `true`) silently opens access during an outage. Supplied by the
     * codegen feeder; absent for runtime callers, where the lint finds nothing.
     */
    flagSecurityDefaults?: ReadonlyArray<AdvisorFlagSecurityDefault>;

    /**
     * `withGeoIndex("name", …)` reads discovered in function bodies — the use-side
     * input the `geo_index_unused` lint cross-references against the declared geo
     * indexes in {@link LintContext.schema}. A declared `.geoIndex(name, …)` with
     * no matching read is dead overhead (its geohash companion is maintained on
     * every write and read by nothing). Supplied by the codegen feeder; absent for
     * runtime callers, where the lint finds nothing.
     */
    geoIndexUsages?: ReadonlyArray<AdvisorGeoIndexUsage>;

    /**
     * `httpAction`/`httpRoute` handlers that perform a side effect
     * (`ctx.runMutation` / `ctx.runAction` / a `ctx.db` write) from the HTTP edge,
     * with whether each reads `ctx.auth` — the `http_action_missing_auth_guard`
     * input. Supplied by the codegen feeder; absent for runtime callers, where the
     * lint finds nothing.
     */
    httpActionGuards?: ReadonlyArray<AdvisorHttpActionGuard>;

    /**
     * Response-header writes, inside `httpAction` handlers, whose value is derived
     * from raw request input (`request.headers`/URL/query/body) with no CR/LF
     * sanitizer — the `http_action_response_header_injection` input. Supplied by the
     * codegen feeder; absent for runtime callers, where the lint finds nothing.
     */
    httpHeaderWrites?: ReadonlyArray<AdvisorHttpHeaderWrite>;

    /**
     * Hyperdrive `ctx.sql` accesses discovered lexically inside `query`/`mutation`
     * handler bodies — the `hyperdrive_outside_action` input. Supplied by the
     * codegen feeder, which omits `action` handlers (where `ctx.sql` is the typed,
     * intended surface); absent for runtime callers, where the lint finds nothing.
     */
    hyperdriveCalls?: ReadonlyArray<AdvisorHyperdriveCall>;

    /**
     * `<receiver>.identity.<key>` claim reads (RLS/mask policy `auth`, or
     * `ctx.auth`/`context.auth`) — the `identity_undeclared_claim_trusted` input.
     * `defineIdentity` validates only declared claims and forwards undeclared ones
     * verbatim, so each row's `declared` flag says whether `key` is in the contract
     * (or the always-present `userId`); the lint fires on the undeclared reads.
     * Supplied by the codegen feeder — and only when a resolvable `defineIdentity`
     * contract exists; absent for runtime callers, where the lint finds nothing.
     */
    identityClaimReads?: ReadonlyArray<AdvisorIdentityClaimRead>;

    /**
     * `buildImageDeliveryUrl({ key, … })` calls (`@lunora/bindings/images`) whose
     * `key` — the CDN transform's source image, an absolute URL or an
     * origin-relative key — is derived from the handler's `args` with no
     * server-side scoping — the `images_url_source_from_user_input` input.
     * `ctx.images.transform`/`info` take image bytes, never a URL, so they are
     * not sinks; only the `key` of `buildImageDeliveryUrl` accepts a URL-or-key
     * source and is inspected. An arg-derived key lets any caller point the
     * CDN's `/cdn-cgi/image/` transform at an attacker-chosen origin (SSRF /
     * open proxy). A fixed literal, or a key scoped by a server-trusted `ctx.*`
     * value, is not recorded. Supplied by the codegen feeder; absent for
     * runtime callers, where the lint finds nothing.
     */
    imageDeliveryUrlAccesses?: ReadonlyArray<AdvisorImageDeliveryUrlAccess>;

    /**
     * Per-declared-index hit counts observed at runtime (the dead-index half of
     * the `index_utilization` lint input). Supplied by the studio backend, which
     * sums the per-`(table, index)` reads each shard records in the durable
     * `__lunora_metrics_index` table and surfaces through the `getMetrics` admin
     * RPC (see {@link AdvisorIndexHit}). Absent for static callers, where the
     * dead-index check finds nothing.
     */
    indexHits?: ReadonlyArray<AdvisorIndexHit>;

    /**
     * Insert writes discovered in function bodies (the `table_without_insert`
     * input). Supplied by the codegen feeder; absent for runtime callers, where
     * the write-shaped lints simply find nothing.
     */
    inserts?: ReadonlyArray<AdvisorInsertWrite>;

    /**
     * `ctx.kv.<method>(key, …)` calls whose namespace key is derived from the
     * handler's `args` with no server-side scoping — the `kv_unscoped_user_key_idor`
     * input. Workers KV is one flat namespace, so a key taken straight from request
     * input lets any caller read/overwrite/delete another user's entry (IDOR). Only
     * arg-derived, unscoped keys are recorded (a fixed literal or a
     * `${ctx.auth.userId}:…` prefix is not). Supplied by the codegen feeder; absent
     * for runtime callers, where the lint finds nothing.
     */
    kvKeyAccesses?: ReadonlyArray<AdvisorKvKeyAccess>;

    /**
     * `ctx.mail`/`ctx.email` `send`/`queue` calls whose `to`/`cc`/`bcc` recipient is
     * derived from the handler's `args` with no server-side scoping — the
     * `mail_recipient_from_request_input` input. A recipient taken straight from
     * request input turns the deployment into an open relay / spam amplifier (any
     * caller can direct mail to an arbitrary address). A recipient scoped by a
     * server-trusted `ctx.*` value, or a fixed literal, is not recorded. Supplied by
     * the codegen feeder; absent for runtime callers, where the lint finds nothing.
     */
    mailRecipientAccesses?: ReadonlyArray<AdvisorMailRecipientAccess>;

    /**
     * Per-procedure column-masking usage discovered in function bodies (the
     * `mask_uncovered_pii_column` input). Carries whether each procedure's builder
     * chain includes `.use(mask(...))`, which `(table, column)` pairs its mask
     * policy declares, and which tables the procedure reads/writes. Supplied by
     * the codegen feeder; absent for runtime callers, where the lint finds
     * nothing.
     */
    maskProcedures?: ReadonlyArray<AdvisorMaskProcedure>;

    /**
     * Masked columns whose `mask(policies)` strategy is a statically-known
     * literal (the `mask_weak_hash_strategy_on_pii` input). One row per masked
     * column, with the `"hash"` / `"redact"` strategy literal attached; a
     * `MaskFn` (custom, non-literal) strategy is never recorded. Supplied by
     * the codegen feeder; absent for runtime callers, where the lint finds
     * nothing.
     */
    maskStrategies?: ReadonlyArray<AdvisorMaskStrategy>;

    /**
     * Whole-row `ctx.db.replace(id, document)` writes lifted from custom
     * mutators' authoritative `server` impls (the `mutator_full_row_replace`
     * input). Each `replace` overwrites the entire row, clobbering a concurrent
     * edit to a different column on a synced table. Supplied by the codegen
     * feeder; absent for runtime callers, where the lint finds nothing.
     */
    mutatorWrites?: ReadonlyArray<AdvisorMutatorWrite>;

    /**
     * Non-deterministic API calls (`Date.now`, `Math.random`,
     * `crypto.randomUUID`, `crypto.getRandomValues`, `fetch`) discovered lexically
     * inside `query`/`mutation` handler bodies — the `nondeterministic_query_mutation`
     * input. Supplied by the codegen feeder, which omits `action` handlers (their
     * non-determinism is intentional); absent for runtime callers, where the lint
     * finds nothing.
     */
    nondeterministicCalls?: ReadonlyArray<AdvisorNondeterministicCall>;

    /**
     * `query`/`mutation` handlers that gate a `ctx.db.get`/`patch`/`delete` on a
     * null-checked `ctx.db.normalizeId(table, id)` result — the
     * `normalize_id_used_as_authorization` input. `normalizeId` validates an id's
     * structural shape only (it never reads the database), so gating access on a
     * non-null result is an IDOR. The lint keeps only public procedures with no
     * `.use(rls(...))` and no ownership/identity mention, then joins `table` against
     * the schema's RLS mode before flagging. Supplied by the codegen feeder; absent
     * for runtime callers, where the lint finds nothing.
     */
    normalizeIdAuthorizations?: ReadonlyArray<AdvisorNormalizeIdAuthorization>;

    /**
     * `ctx.notify` / `ctx.push` sends discovered lexically inside `query`/`mutation`
     * handler bodies — the `notify_send_outside_action` input. Supplied by the
     * codegen feeder, which omits `action` handlers (where these facades are the
     * typed, intended surface); absent for runtime callers, where the lint finds
     * nothing.
     */
    notifyCalls?: ReadonlyArray<AdvisorNotifyCall>;

    /**
     * Whether the app uses `ctx.push` and which push channels `defineNotify(...)`
     * wires — the `notify_missing_push_config` input. Supplied by the codegen
     * feeder from the resolved `lunora/notify.ts` definition; absent for runtime
     * callers, where the lint finds nothing.
     */
    notifyConfig?: AdvisorNotifyConfig;

    /**
     * `ctx.db` writes (`insert` / `replace` / `patch` / `insertManyUnsafe`) that set
     * an ownership / identity column (`userId`, `ownerId`, `tenantId`, …) from the
     * handler's `args` instead of the server-trusted identity — the
     * `owner_field_from_args_not_auth` input. The ownership column decides who a row
     * belongs to, so an arg-derived value lets any caller write rows owned by another
     * user or tenant (act-as-any-user / cross-tenant IDOR). A column stamped from
     * `ctx.*`, or a fixed literal, is not recorded. Supplied by the codegen feeder;
     * absent for runtime callers, where the lint finds nothing.
     */
    ownerFieldWrites?: ReadonlyArray<AdvisorOwnerFieldWrite>;

    /**
     * Payment webhook-adapter constructions (`createStripeAdapter` /
     * `createPolarAdapter` / `createAutumnAdapter` / `createDodoPaymentsAdapter`) — the payment-webhook wide-tolerance lint's input. Each row's
     * `toleranceSeconds` is the statically-known `webhookToleranceSeconds` replay
     * window (default 300s); the lint fires only above a conservative ceiling, where
     * the endpoint would accept stale, replayable signed payloads. Supplied by the
     * codegen feeder; absent for runtime callers, where the lint finds nothing.
     */
    paymentWebhooks?: ReadonlyArray<AdvisorPaymentWebhook>;

    /**
     * Payload-derived privileged dispatches — the `privileged_dispatch_unvalidated_payload`
     * input. Each is a `ctx.run`/`context.run` back into a Lunora function from inside a
     * `defineQueue` push handler or a `defineWorkflow` handler, whose args reference the
     * handler's untrusted payload (`context.params` for a workflow, a `for (… of
     * batch.messages)` body for a queue). Both handler kinds run under the system identity
     * (RLS disabled), so the lint joins the resolved target against `rlsProcedures` and
     * fires only when the target enforces a row policy. Supplied by the codegen feeder;
     * absent for runtime callers, where the lint finds nothing.
     */
    privilegedDispatches?: ReadonlyArray<AdvisorPrivilegedDispatch>;

    /**
     * Per-procedure protective-middleware snapshots — the
     * `public_mutation_without_ratelimit` and `user_creating_mutation_without_captcha`
     * input. Records which `.use(...)` guards (`rateLimit`, captcha, `rls`, `mask`,
     * the `protectPublic` bundle) each procedure carries and whether it writes a
     * user table or sends mail. Supplied by the codegen feeder; absent for runtime
     * callers, where the lints find nothing.
     */
    procedureProtections?: ReadonlyArray<AdvisorProcedureProtection>;

    /**
     * Query reads discovered in function bodies (the `filter_without_index`
     * input). Supplied by the codegen feeder; absent for runtime callers, where
     * the query-shaped lints simply find nothing.
     */
    queries?: ReadonlyArray<AdvisorQueryRead>;

    /**
     * Queues declared via `defineQueue` exports in `lunora/queues.ts` — the
     * declaration-side input for the `queue_*` lints (`queue_without_dlq`).
     * Supplied by the codegen feeder; absent for runtime callers, where the
     * queue lints find nothing.
     */
    queues?: ReadonlyArray<AdvisorQueue>;

    /**
     * R2 SQL `ctx.r2sql` accesses discovered lexically inside `query`/`mutation`
     * handler bodies — the `r2sql_outside_action` input. Supplied by the codegen
     * feeder, which omits `action` handlers (where `ctx.r2sql` is the typed,
     * intended surface); absent for runtime callers, where the lint finds nothing.
     */
    r2sqlCalls?: ReadonlyArray<AdvisorR2sqlCall>;

    /**
     * `rateLimit`/`dbRateLimit` middleware calls (`@lunora/ratelimit`) whose
     * `key` selector is derived from the handler's `args` with no server-side
     * scoping — the `ratelimit_key_spoofable_or_global` input. A key an
     * attacker controls lets them rotate it per request and bypass the limit
     * entirely, defeating its purpose. A selector scoped by `ctx` (e.g.
     * `ctx.auth.userId`, `ctx.ip`), or one with no `args` reference at all (a
     * fixed/global bucket), is not recorded. Supplied by the codegen feeder;
     * absent for runtime callers, where the lint finds nothing.
     */
    ratelimitKeySelectors?: ReadonlyArray<AdvisorRatelimitKeySelector>;

    /* eslint-disable no-secrets/no-secrets -- the referenced lint rule id in the doc comment, not a credential */

    /**
     * `query` handlers that `return` the raw rows of a table (a `ctx.db` row read
     * or `ctx.db.query(...)` fluent chain, returned directly or through one local
     * `const` hop, with no hand-built projection) — the
     * `output_projection_missing_on_public_read` input. The lint keeps only public
     * queries with no `.output(...)`/mask on the chain, then joins `table` against
     * the schema's PII-named columns before nudging. Supplied by the codegen
     * feeder; absent for runtime callers, where the lint finds nothing.
     */
    rawRowReturns?: ReadonlyArray<AdvisorRawRowReturn>;
    /* eslint-enable no-secrets/no-secrets -- re-enable after the rawRowReturns doc block */

    /**
     * `ctx.db.<table>.findMany({ with: { <rel> } })` relation-hydrating list reads
     * — the `masked_relation_leak_via_with` input. Column masking is applied to a
     * read's top-level rows but does not descend into `with`-hydrated relations,
     * so a masked table surfaced only through a `with` on an unprotected public
     * read is returned in the clear. Supplied by the codegen feeder; absent for
     * runtime callers, where the lint finds nothing.
     */
    relationLoads?: ReadonlyArray<AdvisorRelationLoad>;

    /**
     * Per-procedure RLS usage discovered in function bodies (the
     * `rls_uncovered_table` input). Carries whether each procedure's builder chain
     * includes `.use(rls(...))`, which tables the procedure reads/writes, and which
     * tables its RLS policy array names. Supplied by the codegen feeder; absent for
     * runtime callers, where the lint finds nothing.
     */
    rlsProcedures?: ReadonlyArray<AdvisorRlsProcedure>;

    /** The declared schema under audit, normalized to the feeder-agnostic {@link AdvisorSchema}. */
    schema: AdvisorSchema;

    /**
     * Secret-shaped string literals discovered in the lunora source — the
     * `hardcoded_secret` input. Each carries only a redacted preview, never the
     * full value. Supplied by the codegen feeder; absent for runtime callers,
     * where the lint finds nothing.
     */
    secretLiterals?: ReadonlyArray<AdvisorSecretLiteral>;

    /**
     * Replication shapes declared via `defineShape` in `lunora/shapes.ts` — the
     * `shape_unknown_table` and `shape_targets_global_table` lint input. Each
     * carries the export name and its static `table` literal, cross-referenced
     * against {@link LintContext.schema}. Supplied by the codegen feeder; absent
     * for runtime callers, where the shape lints find nothing.
     */
    shapes?: ReadonlyArray<AdvisorShape>;

    /**
     * Per-shard observed traffic — the `hot_shard` lint input. Supplied by the
     * studio backend, which fans out over a sharded function's shards and reads
     * each shard's recorded request volume from the durable `__lunora_metrics`
     * accumulator. Absent for static callers, where the lint finds nothing.
     */
    shardTraffic?: ReadonlyArray<AdvisorShardTraffic>;

    /**
     * `ctx.db.<table>.findMany({ includeDeleted })` list reads whose
     * `includeDeleted` is a hardcoded `true` or derived from the handler's
     * `args` — the `soft_delete_include_deleted_from_args` input. On a public
     * read of a `.softDelete()` table this resurfaces soft-deleted rows to any
     * caller (arg-derived) or every caller (hardcoded). Supplied by the codegen
     * feeder; absent for runtime callers, where the lint finds nothing.
     */
    softDeleteReads?: ReadonlyArray<AdvisorSoftDeleteRead>;

    /**
     * `ctx.sql` tagged-template interpolations that splice an unparameterized
     * string-building expression into the query — the `sql_injection_risk` input.
     * Supplied by the codegen feeder; absent for runtime callers, where the lint
     * finds nothing.
     */
    sqlInterpolations?: ReadonlyArray<AdvisorSqlInterpolation>;

    /**
     * Imports of a migrated-away platform's SDK still present in `lunora/` source
     * — the `migration_stale_import` input. Supplied by the codegen feeder; absent
     * for runtime callers, where the lint finds nothing.
     */
    staleMigrationImports?: ReadonlyArray<AdvisorStaleMigrationImport>;

    /**
     * `ctx.storage.<bucket>.<method>(key, …)` calls whose R2 object key is derived
     * from the handler's `args` with no server-side scoping — the
     * `storage_key_from_user_args` input. The bucket read/write/URL/delete methods
     * key by their first argument, so an arg-derived key is object-level IDOR
     * (read/overwrite/delete anyone's object). A key referencing a server-trusted
     * `ctx.*` value (e.g. `${ctx.auth.userId}/…`) is treated as scoped and not
     * recorded. Supplied by the codegen feeder; absent for runtime callers, where
     * the lint finds nothing.
     */
    storageKeyAccesses?: ReadonlyArray<AdvisorStorageKeyAccess>;

    /**
     * Tracked `ctx.storage.<bucket>.<method>(...)` upload/signing calls — the
     * shared input for the storage config-hygiene lints
     * (`storage_upload_without_content_type_allowlist`, `storage_upload_without_max_size`,
     * `storage_generate_upload_url_no_content_type_pin`,
     * `storage_presigned_url_for_private_content`). Each row carries the method
     * invoked, which options-object keys were present, and (for the two URL
     * signers) a statically-known `expiresInSeconds` literal. Supplied by the
     * codegen feeder; absent for runtime callers, where these lints find
     * nothing.
     */
    storageUploads?: ReadonlyArray<AdvisorStorageUpload>;

    /**
     * Per-table full-scan volume observed at runtime (the hot-scan half of the
     * `index_utilization` lint input). Sourced from the per-`(function, table)`
     * full-scan attribution the runtime records (`__lunora_metrics_scans`,
     * surfaced as `FunctionCallStat.scannedTables`), aggregated across functions
     * and shards. Absent for static callers, where the lint finds nothing.
     */
    tableScans?: ReadonlyArray<AdvisorTableScan>;

    /**
     * Branching shape/policy predicate arms returning an unrestricted filter (`{}` /
     * `undefined`) — the `unrestricted_where_branch` lint input. Supplied by the
     * codegen feeder only.
     */
    unrestrictedWhereBranches?: ReadonlyArray<AdvisorUnrestrictedWhereBranch>;

    /**
     * `ctx.vectors.<method>(index, { namespace, … })` calls whose `namespace` is
     * derived from the handler's `args` with no server-side scoping — the
     * `vectors_namespace_from_user_input` input. A Vectorize namespace partitions one
     * index into isolated sub-collections, so an arg-derived namespace lets any caller
     * read or poison another tenant's vectors. A namespace scoped by a server-trusted
     * `ctx.*` value, or a fixed literal, is not recorded. Supplied by the codegen
     * feeder; absent for runtime callers, where the lint finds nothing.
     */
    vectorNamespaceAccesses?: ReadonlyArray<AdvisorVectorNamespaceAccess>;

    /**
     * `ctx.workflows.get("name")` call sites discovered in function bodies — the
     * use-side input the `workflow_unused` and `workflow_unknown_target` lints
     * cross-reference against {@link LintContext.workflows}. Supplied by the
     * codegen feeder; absent for runtime callers, where the workflow lints find
     * nothing.
     */
    workflowCalls?: ReadonlyArray<AdvisorWorkflowCall>;

    /**
     * Workflows declared via `defineWorkflow` exports in `lunora/workflows.ts` —
     * the declaration-side input for the `workflow_*` lints. Supplied by the
     * codegen feeder; absent for runtime callers, where the workflow lints find
     * nothing.
     */
    workflows?: ReadonlyArray<AdvisorWorkflow>;

    /**
     * Committed `wrangler.jsonc` `vars` entries holding plaintext secrets — the
     * input for the `plaintext_secret_in_wrangler_vars` lint. Supplied by
     * `@lunora/config` (which reads `wrangler.jsonc`) via the codegen pass-through;
     * absent for runtime callers, where the lint finds nothing.
     */
    wranglerVariables?: ReadonlyArray<AdvisorWranglerVariable>;
}

/**
 * A single advisory rule. `run` is pure over its {@link LintContext} so lints are
 * trivially testable and order-independent. Each rule owns the static metadata
 * (`name`/`title`/…) that its findings inherit, keeping individual `Finding`
 * construction to just the per-occurrence `detail`/`metadata`/`cacheKey`.
 */
export interface Lint {
    /** Concern buckets every finding from this lint carries. */
    categories: Category[];
    /** General-purpose description shared by every finding. */
    description: string;
    /** Default audience for this lint's findings. */
    facing: Facing;
    /** Default severity for this lint's findings. */
    level: Level;
    /** Unique lint id, snake_case (e.g. `unindexed_foreign_key`). */
    name: string;
    /** Fix guidance shared by every finding. */
    remediation: string;
    /** Produce zero or more findings for the given context. */
    run: (context: LintContext) => Finding[];
    /** Evidence source — see {@link LintSource}. */
    source: LintSource;
    /** Short headline shared by every finding. */
    title: string;
}
