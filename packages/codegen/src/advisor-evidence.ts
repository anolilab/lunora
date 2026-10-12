/**
 * The advisor's evidence: every discovery pass a lint reads, normalized into the
 * advisor's context. Kept apart from `runCodegen` so the orchestration there reads as
 * phases, and so a new lint's evidence is added in one place.
 */
import type { LintContext } from "@lunora/advisor";
import type { Project } from "ts-morph";

import { toAdvisorContext } from "./advisor";
import type { CallSites } from "./architecture";
import type { buildDeclarationSurface } from "./declaration-surface";
import discoverAdminRoutes from "./discover/admin-routes";
import discoverAiRawRuns from "./discover/ai-raw-runs";
import discoverAiToolSideEffects from "./discover/ai-tool-side-effects";
import discoverArgumentDerivedFetches from "./discover/argument-derived-fetches";
import discoverArgumentValidators from "./discover/argument-validators";
import discoverAuthConfig from "./discover/auth-config";
import discoverAuthApiCalls from "./discover/authapi-calls";
import discoverBrowserUrlAccesses from "./discover/browser-url-accesses";
import discoverConfigCalls from "./discover/config-calls";
import discoverContainerKeyAccesses from "./discover/container-key-accesses";
import discoverContainerOverrides from "./discover/container-overrides";
import discoverExportSinks from "./discover/export-sinks";
import discoverFailOpenGuards from "./discover/fail-open-guards";
import discoverFlagReads from "./discover/flag-reads";
import discoverFlagSecurityDefaults from "./discover/flag-security-defaults";
import discoverGeoIndexUsages from "./discover/geo-index-usages";
import discoverHttpActionGuards from "./discover/http-action-guards";
import discoverHttpHeaderWrites from "./discover/http-header-writes";
import discoverHyperdriveCalls from "./discover/hyperdrive-calls";
import discoverIdentityClaimReads from "./discover/identity-claim-reads";
import discoverImageDeliveryUrlAccesses from "./discover/image-delivery-url-accesses";
import discoverKvKeyAccesses from "./discover/kv-key-accesses";
import discoverMailRecipientAccesses from "./discover/mail-recipient-accesses";
import discoverMaskProcedures from "./discover/mask-procedures";
import discoverMaskStrategies from "./discover/mask-procedures/strategies";
import discoverMutatorWrites from "./discover/mutator-writes";
import discoverNondeterministicCalls from "./discover/nondeterministic-calls";
import discoverNormalizeIdAuthorization from "./discover/normalize-id-authorization";
import { discoverNotifyCalls, discoverNotifyConfig } from "./discover/notify";
import discoverOwnerFieldWrites from "./discover/owner-field-writes";
import discoverPaymentWebhooks from "./discover/payment-webhooks";
import discoverPrivilegedDispatches from "./discover/privileged-dispatches";
import discoverProcedureMiddleware from "./discover/procedure-middleware";
import discoverR2sqlCalls from "./discover/r2sql-calls";
import discoverRatelimitKeySelectors from "./discover/ratelimit-key-selectors";
import discoverRawRowReturns from "./discover/raw-row-returns";
import discoverRelationLoads from "./discover/relation-loads";
import discoverRlsProcedures from "./discover/rls-procedures";
import discoverRowEffects from "./discover/row-effects";
import discoverSecrets from "./discover/secrets";
import discoverSoftDeleteReads from "./discover/soft-delete-reads";
import discoverSqlInterpolation from "./discover/sql-interpolation";
import discoverStaleMigrationImports from "./discover/stale-migration-imports";
import discoverStorageKeyAccesses from "./discover/storage-key-accesses";
import discoverStorageUploads from "./discover/storage-uploads";
import discoverUnboundedLoops from "./discover/unbounded-loops";
import discoverUnrestrictedWhereBranches from "./discover/unrestricted-where-branches";
import discoverVectorNamespaceAccesses from "./discover/vector-namespace-accesses";
import type { FunctionIR, ModuleIR, MutatorIR, SchemaIR, ShapeIR, WranglerVariableIR } from "./ir";

type Surface = ReturnType<typeof buildDeclarationSurface>;

/** The codegen results an advisor lint reads, built before the advisor runs. */
export interface AdvisorEvidenceInputs {
    agents: Surface["agents"];
    callSites: CallSites;
    containers: Surface["containers"];
    crons: Surface["crons"];
    functions: ReadonlyArray<FunctionIR>;
    modules: ReadonlyArray<ModuleIR>;
    mutators: ReadonlyArray<MutatorIR>;
    queues: Surface["queues"];
    schema: SchemaIR;
    shapes: ReadonlyArray<ShapeIR>;
    workflows: Surface["workflows"];
    wranglerVariables?: ReadonlyArray<WranglerVariableIR>;
}

/** Gather the advisor's evidence for one project, with every discovery pass the lints read. */
export const advisorEvidenceOf = (project: Project, lunoraDirectory: string, inputs: AdvisorEvidenceInputs): LintContext => {
    const { callSites, containers, crons, functions, modules, mutators, queues, schema, shapes, wranglerVariables, workflows } = inputs;

    return toAdvisorContext({
        adminRoutes: discoverAdminRoutes(project, lunoraDirectory),
        aiRawRuns: discoverAiRawRuns(project, lunoraDirectory),
        aiToolSideEffects: discoverAiToolSideEffects(project, lunoraDirectory),
        argumentDerivedFetches: discoverArgumentDerivedFetches(project, lunoraDirectory),
        argumentValidators: discoverArgumentValidators(project, lunoraDirectory),
        authApiCalls: discoverAuthApiCalls(project, lunoraDirectory),
        authConfigs: discoverAuthConfig(project, lunoraDirectory),
        browserUrlAccesses: discoverBrowserUrlAccesses(project, lunoraDirectory),
        callEdges: callSites.callEdges,
        configCalls: discoverConfigCalls(project, lunoraDirectory),
        containerKeyAccesses: discoverContainerKeyAccesses(project, lunoraDirectory),
        containerOverrides: discoverContainerOverrides(project, lunoraDirectory),
        containers,
        cronTargets: crons.flatMap((job) => (job.functionPath === undefined ? [] : [job.functionPath])),
        exportSinks: discoverExportSinks(project, lunoraDirectory),
        staleMigrationImports: discoverStaleMigrationImports(project, lunoraDirectory),
        failOpenGuards: discoverFailOpenGuards(project, lunoraDirectory),
        flagReads: discoverFlagReads(project, lunoraDirectory),
        flagSecurityDefaults: discoverFlagSecurityDefaults(project, lunoraDirectory),
        geoIndexUsages: discoverGeoIndexUsages(project, lunoraDirectory),
        httpActionGuards: discoverHttpActionGuards(project, lunoraDirectory),
        httpHeaderWrites: discoverHttpHeaderWrites(project, lunoraDirectory),
        hyperdriveCalls: discoverHyperdriveCalls(project, lunoraDirectory),
        identityClaimReads: discoverIdentityClaimReads(project, lunoraDirectory),
        imageDeliveryUrlAccesses: discoverImageDeliveryUrlAccesses(project, lunoraDirectory),
        inserts: callSites.inserts,
        kvKeyAccesses: discoverKvKeyAccesses(project, lunoraDirectory, functions),
        mailRecipientAccesses: discoverMailRecipientAccesses(project, lunoraDirectory),
        maskProcedures: discoverMaskProcedures(project, lunoraDirectory),
        maskStrategies: discoverMaskStrategies(project, lunoraDirectory),
        mutatorWrites: discoverMutatorWrites(project, lunoraDirectory),
        nondeterministicCalls: discoverNondeterministicCalls(project, lunoraDirectory),
        normalizeIdAuthorizations: discoverNormalizeIdAuthorization(project, lunoraDirectory),
        notifyCalls: discoverNotifyCalls(project, lunoraDirectory),
        notifyConfig: discoverNotifyConfig(project, lunoraDirectory),
        mutators,
        ownerFieldWrites: discoverOwnerFieldWrites(project, lunoraDirectory, functions, mutators),
        unrestrictedWhereBranches: discoverUnrestrictedWhereBranches(project, lunoraDirectory),
        paymentWebhooks: discoverPaymentWebhooks(project, lunoraDirectory),
        privilegedDispatches: discoverPrivilegedDispatches(project, lunoraDirectory),
        procedureProtections: discoverProcedureMiddleware(project, lunoraDirectory),
        queries: callSites.queries,
        queues,
        r2sqlCalls: discoverR2sqlCalls(project, lunoraDirectory),
        ratelimitKeySelectors: discoverRatelimitKeySelectors(project, lunoraDirectory),
        rawRowReturns: discoverRawRowReturns(project, lunoraDirectory),
        relationLoads: discoverRelationLoads(project, lunoraDirectory),
        rlsProcedures: discoverRlsProcedures(project, lunoraDirectory),
        schema,
        secretLiterals: discoverSecrets(project, lunoraDirectory),
        modules,
        shapes,
        softDeleteReads: discoverSoftDeleteReads(project, lunoraDirectory),
        sqlInterpolations: discoverSqlInterpolation(project, lunoraDirectory),
        storageKeyAccesses: discoverStorageKeyAccesses(project, lunoraDirectory, functions),
        storageUploads: discoverStorageUploads(project, lunoraDirectory),
        tableWrites: callSites.tableWrites,
        rowEffects: discoverRowEffects(project, lunoraDirectory, callSites.tableWrites, callSites.callEdges),
        unboundedLoops: discoverUnboundedLoops(project, lunoraDirectory),
        vectorNamespaceAccesses: discoverVectorNamespaceAccesses(project, lunoraDirectory),
        workflowCalls: callSites.workflowCalls,
        workflows,
        wranglerVariables,
    });
};
