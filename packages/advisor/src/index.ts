/**
 * `@lunora/advisor` — schema & runtime lints (splinter-style advisors) for Lunora.
 *
 * Each {@link Lint} is a pure rule over a {@link LintContext}; {@link runAdvisor}
 * runs a set of them and flattens their {@link Finding}s for the studio Advisors
 * table. The interface is shaped after Supabase's splinter so the UI can render
 * any lint uniformly, but the rules run against Lunora's declared schema (and,
 * later, observed runtime signal) rather than Postgres catalog views.
 */
import { dedupeCacheKeys } from "./dedupe-cache-keys";
import fanOutBreadth from "./lints/runtime/fan-out-breadth";
import hotShard from "./lints/runtime/hot-shard";
import indexUtilization from "./lints/runtime/index-utilization";
import actionFetchSsrf from "./lints/static/action-fetch-ssrf";
import actionWithoutErrorHandling from "./lints/static/action-without-error-handling";
import adminRouteWithoutGuard from "./lints/static/admin-route-without-guard";
import aiRawRunEscapeHatch from "./lints/static/ai-raw-run-escape-hatch";
import aiRunWithoutLogging from "./lints/static/ai-run-without-logging";
import aiToolSideEffectPromptInjection from "./lints/static/ai-tool-side-effect-prompt-injection";
import aiUnboundedGenerationPublic from "./lints/static/ai-unbounded-generation-public";
import allowUnauthenticatedShardAccessEnabled from "./lints/static/allow-unauthenticated-shard-access-enabled";
import authApiCallWithoutHeaders from "./lints/static/auth-api-call-without-headers";
import authCsrfCheckDisabled from "./lints/static/auth-csrf-check-disabled";
import authEmailVerificationDisabled from "./lints/static/auth-email-verification-disabled";
import authScimWithoutTransactions from "./lints/static/auth-scim-without-transactions";
import authSecureCookiesDisabled from "./lints/static/auth-secure-cookies-disabled";
import authSessionFreshageZero from "./lints/static/auth-session-freshage-zero";
import authTrustedOriginsWildcard from "./lints/static/auth-trusted-origins-wildcard";
import browserAllowPrivateTargets from "./lints/static/browser-allow-private-targets";
import browserUserUrlWithoutAllowlist from "./lints/static/browser-user-url-without-allowlist";
import circularFk from "./lints/static/circular-fk";
import commitOrderedHardDelete from "./lints/static/commit-ordered-hard-delete";
import containerInstanceKeyFromUserInput from "./lints/static/container-instance-key-from-user-input";
import containerOversizedInstance from "./lints/static/container-oversized-instance";
import containerPublicInternet from "./lints/static/container-public-internet";
import containerRuntimeEgressRelaxation from "./lints/static/container-runtime-egress-relaxation";
import containerStartEnableInternetOverride from "./lints/static/container-start-enable-internet-override";
import duplicateIndex from "./lints/static/duplicate-index";
import emptyIndex from "./lints/static/empty-index";
import errorWithoutCatalog from "./lints/static/error-without-catalog";
import exportSinkMisconfigured from "./lints/static/export-sink-misconfigured";
import externalSourceIncrementalNoDeletePath from "./lints/static/external-source-incremental-no-delete-path";
import externalSourceOnGlobal from "./lints/static/external-source-on-global";
import externalSourceUnscoped from "./lints/static/external-source-unscoped";
import filterOnPrimaryKey from "./lints/static/filter-on-primary-key";
import filterWithoutIndex from "./lints/static/filter-without-index";
import flagGatesSecurityWithUnsafeDefault from "./lints/static/flag-gates-security-with-unsafe-default";
import flagReadInSubscription from "./lints/static/flag-read-in-subscription";
import geoIndexFieldNotGeopoint from "./lints/static/geo-index-field-not-geopoint";
import geoIndexUnused from "./lints/static/geo-index-unused";
import globalTableNearColumnLimit from "./lints/static/global-table-near-column-limit";
import hardcodedSecret from "./lints/static/hardcoded-secret";
import httpActionMissingAuthGuard from "./lints/static/http-action-missing-auth-guard";
import httpActionResponseHeaderInjection from "./lints/static/http-action-response-header-injection";
import hyperdriveOutsideAction from "./lints/static/hyperdrive-outside-action";
import identityUndeclaredClaimTrusted from "./lints/static/identity-undeclared-claim-trusted";
import imagesUrlSourceFromUserInput from "./lints/static/images-url-source-from-user-input";
import indexReferencesUnknownField from "./lints/static/index-references-unknown-field";
import insertManyUnsafeUserData from "./lints/static/insert-many-unsafe-user-data";
import kvUnscopedUserKeyIdor from "./lints/static/kv-unscoped-user-key-idor";
import mailInboundDispatchWithoutVerify from "./lints/static/mail-inbound-dispatch-without-verify";
import mailRecipientFromRequestInput from "./lints/static/mail-recipient-from-request-input";
import maskUncoveredPiiColumn from "./lints/static/mask-uncovered-pii-column";
import maskWeakHashStrategyOnPii from "./lints/static/mask-weak-hash-strategy-on-pii";
import maskedRelationLeakViaWith from "./lints/static/masked-relation-leak-via-with";
import migrationStaleImport from "./lints/static/migration-stale-import";
import mutatorFullRowReplace from "./lints/static/mutator-full-row-replace";
import nondeterministicQueryMutation from "./lints/static/nondeterministic-query-mutation";
import normalizeIdUsedAsAuthorization from "./lints/static/normalize-id-used-as-authorization";
import notifyMissingPushConfig from "./lints/static/notify-missing-push-config";
import notifySendOutsideAction from "./lints/static/notify-send-outside-action";
import outputProjectionMissingOnPublicRead from "./lints/static/output-projection-missing-on-public-read";
import ownerFieldFromArgsNotAuth from "./lints/static/owner-field-from-args-not-auth";
import paymentCreateWithoutAuthorize from "./lints/static/payment-create-without-authorize";
import paymentWebhookWideTolerance from "./lints/static/payment-webhook-wide-tolerance";
import plaintextSecretInWranglerVariables from "./lints/static/plaintext-secret-in-wrangler-variables";
import policyReferencesUnknownTable from "./lints/static/policy-references-unknown-table";
import privilegedDispatchUnvalidatedPayload from "./lints/static/privileged-dispatch-unvalidated-payload";
import privilegedFanoutFromPublicProcedure from "./lints/static/privileged-fanout-from-public-procedure";
import procedureWithoutStructuredEvent from "./lints/static/procedure-without-structured-event";
import publicArgumentUsesAny from "./lints/static/public-argument-uses-any";
import publicMutationWithoutRatelimit from "./lints/static/public-mutation-without-ratelimit";
import publicTableRlsOptoutConfusion from "./lints/static/public-table-rls-optout-confusion";
import queueWithoutDlq from "./lints/static/queue-without-dlq";
import r2sqlOutsideAction from "./lints/static/r2sql-outside-action";
import ratelimitDefaultMemoryStore from "./lints/static/ratelimit-default-memory-store";
import ratelimitKeySpoofableOrGlobal from "./lints/static/ratelimit-key-spoofable-or-global";
import ratelimitMiddlewareFailOpen from "./lints/static/ratelimit-middleware-fail-open";
import relationReferencesUnknownField from "./lints/static/relation-references-unknown-field";
import relationReferencesUnknownTable from "./lints/static/relation-references-unknown-table";
import rlsUncoveredTable from "./lints/static/rls-uncovered-table";
import shapeTargetsGlobalTable from "./lints/static/shape-targets-global-table";
import shapeUnknownTable from "./lints/static/shape-unknown-table";
import signupMutationWithoutDisposableGating from "./lints/static/signup-mutation-without-disposable-gating";
import softDeleteIncludeDeletedFromArgs from "./lints/static/soft-delete-include-deleted-from-args";
import sqlInjectionRisk from "./lints/static/sql-injection-risk";
import storageGenerateUploadUrlNoContentTypePin from "./lints/static/storage-generate-upload-url-no-content-type-pin";
import storageKeyFromUserArgs from "./lints/static/storage-key-from-user-args";
import storagePresignedUrlForPrivateContent from "./lints/static/storage-presigned-url-for-private-content";
import storageUploadWithoutContentTypeAllowlist from "./lints/static/storage-upload-without-content-type-allowlist";
import storageUploadWithoutMaxSize from "./lints/static/storage-upload-without-max-size";
import tableWithoutInsert from "./lints/static/table-without-insert";
import ttlFieldNotTimestamp from "./lints/static/ttl-field-not-timestamp";
import unboundedCollect from "./lints/static/unbounded-collect";
import unboundedStringArgument from "./lints/static/unbounded-string-argument";
import unindexedForeignKey from "./lints/static/unindexed-foreign-key";
import unindexedRelationTarget from "./lints/static/unindexed-relation-target";
import unrestrictedWhereBranch from "./lints/static/unrestricted-where-branch";
import userCreatingMutationWithoutCaptcha from "./lints/static/user-creating-mutation-without-captcha";
import vectorsNamespaceFromUserInput from "./lints/static/vectors-namespace-from-user-input";
import workflowDuplicateStepName from "./lints/static/workflow-duplicate-step-name";
import workflowUnknownTarget from "./lints/static/workflow-unknown-target";
import workflowUnused from "./lints/static/workflow-unused";
import type { Finding, Lint, LintContext, LintSource } from "./types";

export type { AdvisorAdminRoute } from "./admin-routes";
// eslint-disable-next-line no-secrets/no-secrets -- false positive: a function name referenced in a comment, not a credential
// `AE_METRIC_EVENTS` / `loadAnalyticsRuntimeMetrics` are QUARANTINED (plan 225 /
// ADVISOR-01), not re-exported here: no writer in the runtime emits the AE
// events this module reads, and the one caller that could supply
// `analyticsMetrics` (the studio's `deriveRuntimeAdvisories`) never does. The
// types stay public — `AnalyticsRuntimeMetrics` is the shape of that still-valid,
// still-optional extension point — but the reader is a design note, not a
// package export, until something actually writes those events.
export type { AnalyticsMetricsOptions, AnalyticsMetricsSource, AnalyticsRuntimeMetrics } from "./ae-metrics";
export type { AdvisorAiRawRun } from "./ai-raw-runs";
export type { AdvisorAiToolSideEffect } from "./ai-tool-side-effects";
export type { AdvisorArgumentDerivedFetch } from "./argument-derived-fetches";
export type { AdvisorArgumentValidator } from "./argument-validators";
export type { AdvisorAuthConfig } from "./auth-config";
export type { AdvisorAuthApiCall } from "./authapi-calls";
export type { AdvisorBrowserUrlAccess } from "./browser-url-accesses";
export type { AdvisorConfigCall } from "./config-calls";
export type { AdvisorContainerKeyAccess } from "./container-key-accesses";
export type { AdvisorContainerOverride } from "./container-overrides";
export type { AdvisorContainer } from "./containers";
export { dedupeCacheKeys } from "./dedupe-cache-keys";
export type { AdvisorExportSink } from "./export-sinks";
export type { AdvisorFailOpenGuard } from "./fail-open-guards";
export type { AdvisorFlagRead } from "./flag-reads";
export type { AdvisorFlagSecurityDefault } from "./flag-security-defaults";
export type { AdvisorGeoIndexUsage } from "./geo-index-usages";
export type { AdvisorHttpActionGuard } from "./http-action-guards";
export type { AdvisorHttpHeaderWrite } from "./http-header-writes";
export type { AdvisorHyperdriveCall } from "./hyperdrive-calls";
export type { AdvisorIdentityClaimRead } from "./identity-claim-reads";
export type { AdvisorImageDeliveryUrlAccess } from "./image-delivery-url-accesses";
export type { AdvisorIndexHit, AdvisorTableScan } from "./index-usage";
export type { AdvisorInsertWrite } from "./inserts";
export type { AdvisorKvKeyAccess } from "./kv-key-accesses";
export { default as fanOutBreadth } from "./lints/runtime/fan-out-breadth";
export { default as hotShard } from "./lints/runtime/hot-shard";
export { default as indexUtilization } from "./lints/runtime/index-utilization";
export { default as actionFetchSsrf } from "./lints/static/action-fetch-ssrf";
export { default as actionWithoutErrorHandling } from "./lints/static/action-without-error-handling";
export { default as adminRouteWithoutGuard } from "./lints/static/admin-route-without-guard";
export { default as aiRawRunEscapeHatch } from "./lints/static/ai-raw-run-escape-hatch";
export { default as aiRunWithoutLogging } from "./lints/static/ai-run-without-logging";
export { default as aiToolSideEffectPromptInjection } from "./lints/static/ai-tool-side-effect-prompt-injection";
export { default as aiUnboundedGenerationPublic } from "./lints/static/ai-unbounded-generation-public";
export { default as allowUnauthenticatedShardAccessEnabled } from "./lints/static/allow-unauthenticated-shard-access-enabled";
export { default as authApiCallWithoutHeaders } from "./lints/static/auth-api-call-without-headers";
export { default as authCsrfCheckDisabled } from "./lints/static/auth-csrf-check-disabled";
export { default as authEmailVerificationDisabled } from "./lints/static/auth-email-verification-disabled";
export { default as authScimWithoutTransactions } from "./lints/static/auth-scim-without-transactions";
export { default as authSecureCookiesDisabled } from "./lints/static/auth-secure-cookies-disabled";
export { default as authSessionFreshageZero } from "./lints/static/auth-session-freshage-zero";
export { default as authTrustedOriginsWildcard } from "./lints/static/auth-trusted-origins-wildcard";
export { default as browserAllowPrivateTargets } from "./lints/static/browser-allow-private-targets";
export { default as browserUserUrlWithoutAllowlist } from "./lints/static/browser-user-url-without-allowlist";
export { default as circularFk } from "./lints/static/circular-fk";
export { default as commitOrderedHardDelete } from "./lints/static/commit-ordered-hard-delete";
export { default as containerInstanceKeyFromUserInput } from "./lints/static/container-instance-key-from-user-input";
export { default as containerOversizedInstance } from "./lints/static/container-oversized-instance";
export { default as containerPublicInternet } from "./lints/static/container-public-internet";
export { default as containerRuntimeEgressRelaxation } from "./lints/static/container-runtime-egress-relaxation";
export { default as containerStartEnableInternetOverride } from "./lints/static/container-start-enable-internet-override";
export { default as duplicateIndex } from "./lints/static/duplicate-index";
export { default as emptyIndex } from "./lints/static/empty-index";
export { default as errorWithoutCatalog } from "./lints/static/error-without-catalog";
export { default as exportSinkMisconfigured } from "./lints/static/export-sink-misconfigured";
export { default as externalSourceIncrementalNoDeletePath } from "./lints/static/external-source-incremental-no-delete-path";
export { default as externalSourceOnGlobal } from "./lints/static/external-source-on-global";
export { default as externalSourceUnscoped } from "./lints/static/external-source-unscoped";
export { default as filterOnPrimaryKey } from "./lints/static/filter-on-primary-key";
export { default as filterWithoutIndex } from "./lints/static/filter-without-index";
export { default as flagGatesSecurityWithUnsafeDefault } from "./lints/static/flag-gates-security-with-unsafe-default";
export { default as flagReadInSubscription } from "./lints/static/flag-read-in-subscription";
export { default as geoIndexFieldNotGeopoint } from "./lints/static/geo-index-field-not-geopoint";
export { default as geoIndexUnused } from "./lints/static/geo-index-unused";
export { default as globalTableNearColumnLimit } from "./lints/static/global-table-near-column-limit";
export { default as hardcodedSecret } from "./lints/static/hardcoded-secret";
export { default as httpActionMissingAuthGuard } from "./lints/static/http-action-missing-auth-guard";
export { default as httpActionResponseHeaderInjection } from "./lints/static/http-action-response-header-injection";
export { default as hyperdriveOutsideAction } from "./lints/static/hyperdrive-outside-action";
export { default as identityUndeclaredClaimTrusted } from "./lints/static/identity-undeclared-claim-trusted";
export { default as imagesUrlSourceFromUserInput } from "./lints/static/images-url-source-from-user-input";
export { default as indexReferencesUnknownField } from "./lints/static/index-references-unknown-field";
export { default as insertManyUnsafeUserData } from "./lints/static/insert-many-unsafe-user-data";
export { default as kvUnscopedUserKeyIdor } from "./lints/static/kv-unscoped-user-key-idor";
export { default as mailInboundDispatchWithoutVerify } from "./lints/static/mail-inbound-dispatch-without-verify";
export { default as mailRecipientFromRequestInput } from "./lints/static/mail-recipient-from-request-input";
export { default as maskUncoveredPiiColumn } from "./lints/static/mask-uncovered-pii-column";
export { default as maskWeakHashStrategyOnPii } from "./lints/static/mask-weak-hash-strategy-on-pii";
export { default as maskedRelationLeakViaWith } from "./lints/static/masked-relation-leak-via-with";
export { default as mutatorFullRowReplace } from "./lints/static/mutator-full-row-replace";
export { default as nondeterministicQueryMutation } from "./lints/static/nondeterministic-query-mutation";
export { default as normalizeIdUsedAsAuthorization } from "./lints/static/normalize-id-used-as-authorization";
export { default as notifyMissingPushConfig } from "./lints/static/notify-missing-push-config";
export { default as notifySendOutsideAction } from "./lints/static/notify-send-outside-action";
export { default as outputProjectionMissingOnPublicRead } from "./lints/static/output-projection-missing-on-public-read";
export { default as ownerFieldFromArgsNotAuth } from "./lints/static/owner-field-from-args-not-auth";
export { default as paymentCreateWithoutAuthorize } from "./lints/static/payment-create-without-authorize";
export { default as paymentWebhookWideTolerance } from "./lints/static/payment-webhook-wide-tolerance";
export { default as plaintextSecretInWranglerVariables } from "./lints/static/plaintext-secret-in-wrangler-variables";
export { default as policyReferencesUnknownTable } from "./lints/static/policy-references-unknown-table";
export { default as privilegedDispatchUnvalidatedPayload } from "./lints/static/privileged-dispatch-unvalidated-payload";
export { default as privilegedFanoutFromPublicProcedure } from "./lints/static/privileged-fanout-from-public-procedure";
export { default as procedureWithoutStructuredEvent } from "./lints/static/procedure-without-structured-event";
export { default as publicArgumentUsesAny } from "./lints/static/public-argument-uses-any";
export { default as publicMutationWithoutRatelimit } from "./lints/static/public-mutation-without-ratelimit";
export { default as publicTableRlsOptoutConfusion } from "./lints/static/public-table-rls-optout-confusion";
export { default as queueWithoutDlq } from "./lints/static/queue-without-dlq";
export { default as r2sqlOutsideAction } from "./lints/static/r2sql-outside-action";
export { default as ratelimitDefaultMemoryStore } from "./lints/static/ratelimit-default-memory-store";
export { default as ratelimitKeySpoofableOrGlobal } from "./lints/static/ratelimit-key-spoofable-or-global";
export { default as ratelimitMiddlewareFailOpen } from "./lints/static/ratelimit-middleware-fail-open";
export { default as relationReferencesUnknownField } from "./lints/static/relation-references-unknown-field";
export { default as relationReferencesUnknownTable } from "./lints/static/relation-references-unknown-table";
export { default as rlsUncoveredTable } from "./lints/static/rls-uncovered-table";
export { default as shapeTargetsGlobalTable } from "./lints/static/shape-targets-global-table";
export { default as shapeUnknownTable } from "./lints/static/shape-unknown-table";
export { default as signupMutationWithoutDisposableGating } from "./lints/static/signup-mutation-without-disposable-gating";
export { default as softDeleteIncludeDeletedFromArgs } from "./lints/static/soft-delete-include-deleted-from-args";
export { default as sqlInjectionRisk } from "./lints/static/sql-injection-risk";
export { default as storageGenerateUploadUrlNoContentTypePin } from "./lints/static/storage-generate-upload-url-no-content-type-pin";
export { default as storageKeyFromUserArgs } from "./lints/static/storage-key-from-user-args";
export { default as storagePresignedUrlForPrivateContent } from "./lints/static/storage-presigned-url-for-private-content";
export { default as storageUploadWithoutContentTypeAllowlist } from "./lints/static/storage-upload-without-content-type-allowlist";
export { default as storageUploadWithoutMaxSize } from "./lints/static/storage-upload-without-max-size";
export { default as tableWithoutInsert } from "./lints/static/table-without-insert";
export { default as ttlFieldNotTimestamp } from "./lints/static/ttl-field-not-timestamp";
export { default as unboundedStringArgument } from "./lints/static/unbounded-string-argument";
export { default as unindexedForeignKey } from "./lints/static/unindexed-foreign-key";
export { default as unindexedRelationTarget } from "./lints/static/unindexed-relation-target";
export { default as unrestrictedWhereBranch } from "./lints/static/unrestricted-where-branch";
export { default as userCreatingMutationWithoutCaptcha } from "./lints/static/user-creating-mutation-without-captcha";
export { default as vectorsNamespaceFromUserInput } from "./lints/static/vectors-namespace-from-user-input";
export { default as workflowDuplicateStepName } from "./lints/static/workflow-duplicate-step-name";
export { default as workflowUnknownTarget } from "./lints/static/workflow-unknown-target";
export { default as workflowUnused } from "./lints/static/workflow-unused";
export type { AdvisorMailRecipientAccess } from "./mail-recipient-accesses";
export type { BaselineComparison, ProcedureDelta } from "./map/baseline";
export { compareToBaseline, parseAdvisorMap } from "./map/baseline";
// The scoring primitives (`scoreProcedure`, `scoreGlobal`, the weight tables) stay
// module-internal: they are implementation of `scoreAdvisor`, and exporting them so
// tests could reach them would freeze arithmetic into the public API snapshot.
// `gradeFromScore` is public because a UI needs to band a score it did not compute.
export { gradeFromScore } from "./map/score";
export type { ScoreAdvisorOptions } from "./map/score-advisor";
export { byCodepoint, MAP_VERSION, scoreAdvisor } from "./map/score-advisor";
export { default as classifySensitivity } from "./map/sensitivity";
export type { AdvisorMap, CheckResult, Coverage, Grade, MapSummary, ProcedureScore, ProjectScore, Sensitivity, SensitivityLevel } from "./map/types";
export type { AdvisorMaskProcedure } from "./mask-procedures";
export type { AdvisorMaskStrategy } from "./mask-strategies";
export type { AdvisorMutatorWrite } from "./mutator-writes";
export type { AdvisorNondeterministicCall } from "./nondeterministic-calls";
export type { AdvisorNormalizeIdAuthorization } from "./normalize-id-authorization";
export type { AdvisorNotifyCall, AdvisorNotifyConfig } from "./notify-calls";
export type { AdvisorOwnerFieldWrite } from "./owner-field-writes";
export type { AdvisorPaymentWebhook } from "./payment-webhooks";
export type { AdvisorPrivilegedDispatch } from "./privileged-dispatches";
export type { AdvisorProcedureProtection } from "./procedure-protections";
export type { AdvisorQueryRead } from "./queries";
export type { AdvisorQueue, AdvisorQueueTuning } from "./queues";
export type { AdvisorR2sqlCall } from "./r2sql-calls";
export type { AdvisorRatelimitKeySelector } from "./ratelimit-key-selectors";
export type { AdvisorRawRowReturn } from "./raw-row-returns";
export type { AdvisorRelationLoad } from "./relation-loads";
export type { AdvisorRlsProcedure } from "./rls-procedures";
export type { AdvisorIndex, AdvisorRelation, AdvisorSchema, AdvisorTable } from "./schema";
export { fromServerSchema } from "./schema";
export type { AdvisorSecretLiteral } from "./secrets";
export type { AdvisorShape } from "./shapes";
export type { AdvisorShardTraffic } from "./shard-traffic";
export type { AdvisorSoftDeleteRead } from "./soft-delete-reads";
export type { AdvisorSqlInterpolation } from "./sql-interpolation";
export type { AdvisorStaleMigrationImport } from "./stale-migration-imports";
export type { AdvisorStorageKeyAccess } from "./storage-key-accesses";
export type { AdvisorStorageUpload } from "./storage-uploads";
export type { Category, Facing, Finding, Level, Lint, LintContext, LintSource } from "./types";
export type { AdvisorVectorNamespaceAccess } from "./vector-namespace-accesses";
export type { AdvisorWorkflow, AdvisorWorkflowCall } from "./workflows";
export type { AdvisorWranglerVariable } from "./wrangler-variables";

/**
 * Every lint that runs against the declared schema (and, for
 * `filter_without_index`, the discovered query reads) — no running shard
 * required. Correctness lints (`*_unknown_*`, `empty_index`) come first so a
 * broken schema's errors surface above the performance advisories.
 */
export const STATIC_LINTS: ReadonlyArray<Lint> = [
    indexReferencesUnknownField,
    relationReferencesUnknownTable,
    relationReferencesUnknownField,
    workflowUnknownTarget,
    workflowDuplicateStepName,
    shapeUnknownTable,
    externalSourceIncrementalNoDeletePath,
    externalSourceOnGlobal,
    externalSourceUnscoped,
    emptyIndex,
    globalTableNearColumnLimit,
    errorWithoutCatalog,
    geoIndexFieldNotGeopoint,
    geoIndexUnused,
    exportSinkMisconfigured,
    ttlFieldNotTimestamp,
    commitOrderedHardDelete,
    circularFk,
    unindexedForeignKey,
    unindexedRelationTarget,
    duplicateIndex,
    tableWithoutInsert,
    workflowUnused,
    queueWithoutDlq,
    filterOnPrimaryKey,
    filterWithoutIndex,
    unboundedCollect,
    shapeTargetsGlobalTable,
    mutatorFullRowReplace,
    nondeterministicQueryMutation,
    hyperdriveOutsideAction,
    r2sqlOutsideAction,
    authApiCallWithoutHeaders,
    policyReferencesUnknownTable,
    rlsUncoveredTable,
    maskUncoveredPiiColumn,
    maskWeakHashStrategyOnPii,
    containerOversizedInstance,
    containerPublicInternet,
    publicMutationWithoutRatelimit,
    unrestrictedWhereBranch,
    userCreatingMutationWithoutCaptcha,
    signupMutationWithoutDisposableGating,
    publicArgumentUsesAny,
    unboundedStringArgument,
    hardcodedSecret,
    sqlInjectionRisk,
    adminRouteWithoutGuard,
    paymentCreateWithoutAuthorize,
    mailInboundDispatchWithoutVerify,
    ratelimitDefaultMemoryStore,
    browserAllowPrivateTargets,
    privilegedFanoutFromPublicProcedure,
    procedureWithoutStructuredEvent,
    insertManyUnsafeUserData,
    aiUnboundedGenerationPublic,
    actionFetchSsrf,
    actionWithoutErrorHandling,
    ownerFieldFromArgsNotAuth,
    storageKeyFromUserArgs,
    kvUnscopedUserKeyIdor,
    containerInstanceKeyFromUserInput,
    aiRawRunEscapeHatch,
    aiRunWithoutLogging,
    vectorsNamespaceFromUserInput,
    mailRecipientFromRequestInput,
    browserUserUrlWithoutAllowlist,
    privilegedDispatchUnvalidatedPayload,
    containerStartEnableInternetOverride,
    containerRuntimeEgressRelaxation,
    authScimWithoutTransactions,
    authTrustedOriginsWildcard,
    authCsrfCheckDisabled,
    authSecureCookiesDisabled,
    authEmailVerificationDisabled,
    authSessionFreshageZero,
    imagesUrlSourceFromUserInput,
    ratelimitKeySpoofableOrGlobal,
    publicTableRlsOptoutConfusion,
    allowUnauthenticatedShardAccessEnabled,
    storageUploadWithoutContentTypeAllowlist,
    storageUploadWithoutMaxSize,
    storageGenerateUploadUrlNoContentTypePin,
    storagePresignedUrlForPrivateContent,
    httpActionMissingAuthGuard,
    httpActionResponseHeaderInjection,
    ratelimitMiddlewareFailOpen,
    flagGatesSecurityWithUnsafeDefault,
    flagReadInSubscription,
    aiToolSideEffectPromptInjection,
    identityUndeclaredClaimTrusted,
    paymentWebhookWideTolerance,
    softDeleteIncludeDeletedFromArgs,
    maskedRelationLeakViaWith,
    outputProjectionMissingOnPublicRead,
    normalizeIdUsedAsAuthorization,
    notifySendOutsideAction,
    notifyMissingPushConfig,
    plaintextSecretInWranglerVariables,
    migrationStaleImport,
];

/**
 * Every lint that needs observed runtime signal (recorded metrics) rather than
 * just the declared schema. They read the feeder-supplied
 * {@link LintContext.shardTraffic} / {@link LintContext.tableScans} /
 * {@link LintContext.indexHits}; absent that signal (a static caller) each is a
 * no-op. Run them with `runAdvisor(ctx, { source: "runtime" })` against a live
 * deployment's aggregated metrics.
 */
export const RUNTIME_LINTS: ReadonlyArray<Lint> = [hotShard, indexUtilization, fanOutBreadth];

/** The default lint set: the static lints, then the runtime lints. A caller filters by `source` to run one tier. */
export const ALL_LINTS: ReadonlyArray<Lint> = [...STATIC_LINTS, ...RUNTIME_LINTS];

/** Options for {@link runAdvisor}. */
export interface RunAdvisorOptions {
    /** Lints to run (default: {@link ALL_LINTS}). */
    lints?: ReadonlyArray<Lint>;
    /** Restrict to a single evidence source — e.g. `"static"` at codegen time. */
    source?: LintSource;
}

/**
 * Run lints against a context and return their findings in lint-declaration
 * order. Filtering by {@link RunAdvisorOptions.source} lets a caller run only
 * `static` lints at build time and defer `runtime` lints to a live shard.
 */
export const runAdvisor = (context: LintContext, options: RunAdvisorOptions = {}): Finding[] => {
    const lints = options.lints ?? ALL_LINTS;
    const findings: Finding[] = [];

    for (const lint of lints) {
        if (options.source !== undefined && lint.source !== options.source) {
            continue;
        }

        findings.push(...lint.run(context));
    }

    // Any two findings that share a `cacheKey` (e.g. two file:line-keyed sinks on
    // one physical source line) would collapse to one dismissible row in the
    // studio, hiding the second. Suffix repeats so every finding survives.
    return dedupeCacheKeys(findings);
};
