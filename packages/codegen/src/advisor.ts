import type {
    AdvisorExportSink,
    AdvisorGeoIndexUsage,
    AdvisorIndex,
    AdvisorNotifyCall,
    AdvisorNotifyConfig,
    AdvisorSchema,
    AdvisorShape,
    Finding,
    LintContext,
} from "@lunora/advisor";
import { runAdvisor } from "@lunora/advisor";

import type {
    AdminRouteIR,
    AiRawRunIR,
    AiToolSideEffectIR,
    ArgumentDerivedFetchIR,
    ArgumentValidatorIR,
    AuthApiCallIR,
    AuthConfigIR,
    BrowserUrlAccessIR,
    ConfigCallIR,
    ContainerIR,
    ContainerKeyAccessIR,
    ContainerOverrideIR,
    FailOpenGuardIR,
    FlagSecurityDefaultIR,
    HttpActionGuardIR,
    HttpHeaderWriteIR,
    IdentityClaimReadIR,
    ImageDeliveryUrlAccessIR,
    InsertWriteIR,
    KvKeyAccessIR,
    MailRecipientAccessIR,
    MaskProcedureIR,
    MaskStrategyIR,
    MutatorWriteIR,
    NondeterministicCallIR,
    NormalizeIdAuthorizationIR,
    OwnerFieldWriteIR,
    PaymentWebhookIR,
    PrivilegedDispatchIR,
    ProcedureMiddlewareIR,
    QueryReadIR,
    QueueIR,
    R2sqlCallIR,
    RatelimitKeySelectorIR,
    RawRowReturnIR,
    RelationLoadIR,
    RlsProcedureIR,
    SchemaIR,
    SecretLiteralIR,
    ShapeIR,
    SoftDeleteReadIR,
    SqlInterpolationIR,
    StaleMigrationImportIR,
    StorageKeyAccessIR,
    StorageUploadIR,
    TableIR,
    UnrestrictedWhereBranchIR,
    VectorNamespaceAccessIR,
    WorkflowCallIR,
    WorkflowIR,
    WranglerVariableIR,
} from "./ir";

/**
 * Flatten a table's per-kind index declarations into the advisor's unified
 * {@link AdvisorIndex} list, tagging each with its `kind` and the columns it
 * touches (a search index's text + filter fields, a rank index's sort +
 * partition fields, a vector index's source field). Inline vector indexes on a
 * table always carry a `field`; the guard drops the Shape-B standalone form
 * (which derives text via a `select` fn and has no column to lint).
 */
const flattenIndexes = (table: TableIR): AdvisorIndex[] => [
    ...table.indexes.map((index): AdvisorIndex => {
        return { fields: index.fields, kind: "index", name: index.name, unique: index.unique };
    }),
    ...table.searchIndexes.map((index): AdvisorIndex => {
        return { fields: [index.field, ...(index.filterFields ?? [])], kind: "search", name: index.name };
    }),
    ...table.rankIndexes.map((index): AdvisorIndex => {
        return { fields: [...index.sortBy.map((key) => key.field), ...(index.partitionBy ?? [])], kind: "rank", name: index.name };
    }),
    ...table.vectorIndexes
        .filter((index) => index.field !== undefined)
        .map((index): AdvisorIndex => {
            return { fields: [index.field as string], kind: "vector", name: index.name };
        }),
    ...(table.geoIndexes ?? []).map((index): AdvisorIndex => {
        return { fields: [index.field], kind: "geo", name: index.name };
    }),
];

/** Effective validator kind per column (a `v.optional(...)` is unwrapped to its inner kind) for the schema-type lints. */
const columnKindsOf = (table: TableIR): Record<string, string> => {
    const kinds: Record<string, string> = {};

    for (const [fieldName, validator] of Object.entries(table.shape)) {
        kinds[fieldName] = validator.kind === "optional" ? (validator.inner?.kind ?? "optional") : validator.kind;
    }

    return kinds;
};

/**
 * Collapse the AST-derived {@link SchemaIR} into the advisor's feeder-agnostic
 * {@link AdvisorSchema}. The IR already carries exactly what static lints read —
 * each table's columns (the `shape` keys), relations, and indexes. Codegen never
 * imports `@lunora/server`, so it builds the advisor input from its own IR
 * rather than going through `fromServerSchema`.
 */
const toAdvisorSchema = (schema: SchemaIR): AdvisorSchema => {
    return {
        rlsMode: schema.rlsMode,
        tables: schema.tables.map((table) => {
            return {
                externallyManaged: table.externallyManaged ?? false,
                externalSource: table.externalSource
                    ? {
                          hasReconcile: table.externalSource.hasReconcile ?? false,
                          hasSoftDelete: table.externalSource.hasSoftDelete ?? false,
                          hasTenantBy: table.externalSource.hasTenantBy,
                          mode: table.externalSource.mode,
                          unanalyzable: table.externalSource.unanalyzable,
                      }
                    : undefined,
                columnKinds: columnKindsOf(table),
                fields: Object.keys(table.shape),
                indexes: flattenIndexes(table),
                isPublic: table.isPublic ?? false,
                name: table.name,
                relations: table.relations.map((relation) => {
                    return {
                        field: relation.field,
                        kind: relation.kind,
                        name: relation.name,
                        onDelete: relation.onDelete,
                        references: relation.references,
                        table: relation.table,
                    };
                }),
                shardKind: typeof table.shardMode === "string" ? table.shardMode : "shardBy",
                softDelete: table.softDelete,
                ttl: table.ttl,
            };
        }),
    };
};

/**
 * Map discovered {@link ShapeIR}s to the advisor's {@link AdvisorShape} evidence
 * — the `shape_unknown_table` / `shape_targets_global_table` lint input. Only
 * the export name + static `table` literal cross the boundary; the runtime
 * object stays authoritative for `columns`/`compileWhere`.
 */
const toAdvisorShapes = (shapes: ReadonlyArray<ShapeIR>): AdvisorShape[] =>
    shapes.map((shape) => {
        return { exportName: shape.exportName, file: `lunora/${shape.filePath}.ts`, table: shape.table };
    });

/**
 * Named inputs for {@link lintSchema}. Every feeder is a discrete key rather than
 * a positional argument: the feeder list grows every few releases and many IR
 * types are structurally similar (`{file, exportName, line}`-shaped evidence),
 * so a positional call was a silent-transposition hazard — swapping two adjacent
 * arguments could typecheck yet feed the wrong evidence to the wrong lint and
 * corrupt a security advisory. `schema` is the only required field; every other
 * feeder defaults to "not analyzed" when omitted.
 */
interface LintSchemaOptions {
    adminRoutes?: ReadonlyArray<AdminRouteIR>;
    aiRawRuns?: ReadonlyArray<AiRawRunIR>;
    aiToolSideEffects?: ReadonlyArray<AiToolSideEffectIR>;
    argumentDerivedFetches?: ReadonlyArray<ArgumentDerivedFetchIR>;
    argumentValidators?: ReadonlyArray<ArgumentValidatorIR>;
    authApiCalls?: ReadonlyArray<AuthApiCallIR>;
    authConfigs?: ReadonlyArray<AuthConfigIR>;
    browserUrlAccesses?: ReadonlyArray<BrowserUrlAccessIR>;
    configCalls?: ReadonlyArray<ConfigCallIR>;
    containerKeyAccesses?: ReadonlyArray<ContainerKeyAccessIR>;
    containerOverrides?: ReadonlyArray<ContainerOverrideIR>;
    containers?: ReadonlyArray<ContainerIR>;
    exportSinks?: ReadonlyArray<AdvisorExportSink>;
    failOpenGuards?: ReadonlyArray<FailOpenGuardIR>;
    flagSecurityDefaults?: ReadonlyArray<FlagSecurityDefaultIR>;
    geoIndexUsages?: ReadonlyArray<AdvisorGeoIndexUsage>;
    httpActionGuards?: ReadonlyArray<HttpActionGuardIR>;
    httpHeaderWrites?: ReadonlyArray<HttpHeaderWriteIR>;
    identityClaimReads?: ReadonlyArray<IdentityClaimReadIR>;
    imageDeliveryUrlAccesses?: ReadonlyArray<ImageDeliveryUrlAccessIR>;
    inserts?: ReadonlyArray<InsertWriteIR>;
    kvKeyAccesses?: ReadonlyArray<KvKeyAccessIR>;
    mailRecipientAccesses?: ReadonlyArray<MailRecipientAccessIR>;
    maskProcedures?: ReadonlyArray<MaskProcedureIR>;
    maskStrategies?: ReadonlyArray<MaskStrategyIR>;
    mutatorWrites?: ReadonlyArray<MutatorWriteIR>;
    nondeterministicCalls?: ReadonlyArray<NondeterministicCallIR>;
    normalizeIdAuthorizations?: ReadonlyArray<NormalizeIdAuthorizationIR>;
    notifyCalls?: ReadonlyArray<AdvisorNotifyCall>;
    notifyConfig?: AdvisorNotifyConfig;
    ownerFieldWrites?: ReadonlyArray<OwnerFieldWriteIR>;
    paymentWebhooks?: ReadonlyArray<PaymentWebhookIR>;
    privilegedDispatches?: ReadonlyArray<PrivilegedDispatchIR>;
    procedureProtections?: ReadonlyArray<ProcedureMiddlewareIR>;
    queries?: ReadonlyArray<QueryReadIR>;
    queues?: ReadonlyArray<QueueIR>;
    r2sqlCalls?: ReadonlyArray<R2sqlCallIR>;
    ratelimitKeySelectors?: ReadonlyArray<RatelimitKeySelectorIR>;
    rawRowReturns?: ReadonlyArray<RawRowReturnIR>;
    relationLoads?: ReadonlyArray<RelationLoadIR>;
    rlsProcedures?: ReadonlyArray<RlsProcedureIR>;
    schema: SchemaIR;
    secretLiterals?: ReadonlyArray<SecretLiteralIR>;
    shapes?: ReadonlyArray<ShapeIR>;
    softDeleteReads?: ReadonlyArray<SoftDeleteReadIR>;
    sqlInterpolations?: ReadonlyArray<SqlInterpolationIR>;
    staleMigrationImports?: ReadonlyArray<StaleMigrationImportIR>;
    storageKeyAccesses?: ReadonlyArray<StorageKeyAccessIR>;
    storageUploads?: ReadonlyArray<StorageUploadIR>;
    unrestrictedWhereBranches?: ReadonlyArray<UnrestrictedWhereBranchIR>;
    vectorNamespaceAccesses?: ReadonlyArray<VectorNamespaceAccessIR>;
    workflowCalls?: ReadonlyArray<WorkflowCallIR>;
    workflows?: ReadonlyArray<WorkflowIR>;
    wranglerVariables?: ReadonlyArray<WranglerVariableIR>;
}

/**
 * Normalize feeder options into the advisor's {@link LintContext} — the input
 * both `runAdvisor` and `scoreAdvisor` take. Shared by {@link lintSchema} so the
 * lint run and the scored map always see byte-identical evidence.
 *
 * Exported instead of a `mapSchema(options)` convenience that lints *and* scores:
 * such a wrapper would either re-run every rule or need a `findings` escape hatch
 * nothing could validate against its `options`, so mismatched findings would
 * silently produce a wrong map. Two lines at the call site buys that away:
 *
 * ```ts
 * const context = toAdvisorContext(options);
 * const map = scoreAdvisor(context.procedureProtections ?? [], runAdvisor(context, { source: "static" }));
 * ```
 */
const toAdvisorContext = (options: LintSchemaOptions): LintContext => {
    const { argumentValidators, queries, schema, shapes, ...rest } = options;

    return {
        ...rest,
        argValidators: argumentValidators,
        queries: queries ?? [],
        schema: toAdvisorSchema(schema),
        shapes: shapes === undefined ? undefined : toAdvisorShapes(shapes),
    } satisfies LintContext;
};

/**
 * Run the static lints against a discovered {@link SchemaIR} and the reads/writes/calls
 * found in function bodies: query reads feed `filter_without_index`, insert writes
 * feed `table_without_insert`, authApi calls feed `auth_api_call_without_headers`,
 * rls procedure snapshots feed `rls_uncovered_table`, mask procedure
 * snapshots feed `mask_uncovered_pii_column`, and per-column mask strategies
 * feed `mask_weak_hash_strategy_on_pii`; declared containers
 * feed the `container_*` lints; declared workflows (with their durable step labels)
 * + `ctx.workflows.get(...)` call sites feed the `workflow_unused` /
 * `workflow_unknown_target` / duplicate-step-name lints; non-deterministic
 * calls inside query/mutation handlers feed the `nondeterministic_query_mutation` lint
 * (all default empty for callers that don't analyze functions/containers/workflows).
 * The IR types are structurally identical to the advisor's evidence types so they
 * pass straight through without conversion. Returns the findings; surfacing them
 * (console, error overlay, studio Advisors table) is the caller's choice.
 */
export const lintSchema = (options: LintSchemaOptions): Finding[] => runAdvisor(toAdvisorContext(options), { source: "static" });

/**
 * Render advisor findings as a single multi-line string for console surfacing:
 * a one-line summary header followed by one `[LEVEL] name: detail` line per
 * finding. Returns `""` when there are no findings.
 */
export const formatAdvisories = (findings: ReadonlyArray<Finding>): string => {
    if (findings.length === 0) {
        return "";
    }

    const header = `@lunora/codegen: ${String(findings.length)} schema advisor finding${findings.length === 1 ? "" : "s"}`;
    const lines = findings.map((finding) => `  [${finding.level}] ${finding.name}: ${finding.detail}`);

    return [header, ...lines].join("\n");
};

export { toAdvisorContext };
export type { LintSchemaOptions };
