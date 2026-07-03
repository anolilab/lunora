import type { AdvisorIndex, AdvisorSchema, AdvisorShape, Finding } from "@lunora/advisor";
import { runAdvisor } from "@lunora/advisor";

import type {
    AdminRouteIR,
    AiRawRunIR,
    ArgumentDerivedFetchIR,
    ArgumentValidatorIR,
    AuthApiCallIR,
    AuthConfigIR,
    BrowserUrlAccessIR,
    ConfigCallIR,
    ContainerIR,
    ContainerKeyAccessIR,
    ContainerOverrideIR,
    ImageDeliveryUrlAccessIR,
    InsertWriteIR,
    KvKeyAccessIR,
    MailRecipientAccessIR,
    MaskProcedureIR,
    MaskStrategyIR,
    MutatorWriteIR,
    NondeterministicCallIR,
    OwnerFieldWriteIR,
    PrivilegedDispatchIR,
    ProcedureMiddlewareIR,
    QueryReadIR,
    R2sqlCallIR,
    RatelimitKeySelectorIR,
    RlsProcedureIR,
    SchemaIR,
    SecretLiteralIR,
    ShapeIR,
    SqlInterpolationIR,
    StorageKeyAccessIR,
    TableIR,
    VectorNamespaceAccessIR,
    WorkflowCallIR,
    WorkflowIR,
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
];

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
                          hasTenantBy: table.externalSource.hasTenantBy,
                          mode: table.externalSource.mode,
                          unanalyzable: table.externalSource.unanalyzable,
                      }
                    : undefined,
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
export const lintSchema = (
    schema: SchemaIR,
    queries: ReadonlyArray<QueryReadIR> = [],
    inserts?: ReadonlyArray<InsertWriteIR>,
    authApiCalls?: ReadonlyArray<AuthApiCallIR>,
    rlsProcedures?: ReadonlyArray<RlsProcedureIR>,
    containers?: ReadonlyArray<ContainerIR>,
    workflows?: ReadonlyArray<WorkflowIR>,
    workflowCalls?: ReadonlyArray<WorkflowCallIR>,
    maskProcedures?: ReadonlyArray<MaskProcedureIR>,
    nondeterministicCalls?: ReadonlyArray<NondeterministicCallIR>,
    procedureProtections?: ReadonlyArray<ProcedureMiddlewareIR>,
    argumentValidators?: ReadonlyArray<ArgumentValidatorIR>,
    secretLiterals?: ReadonlyArray<SecretLiteralIR>,
    sqlInterpolations?: ReadonlyArray<SqlInterpolationIR>,
    adminRoutes?: ReadonlyArray<AdminRouteIR>,
    r2sqlCalls?: ReadonlyArray<R2sqlCallIR>,
    shapes?: ReadonlyArray<ShapeIR>,
    mutatorWrites?: ReadonlyArray<MutatorWriteIR>,
    configCalls?: ReadonlyArray<ConfigCallIR>,
    argumentDerivedFetches?: ReadonlyArray<ArgumentDerivedFetchIR>,
    kvKeyAccesses?: ReadonlyArray<KvKeyAccessIR>,
    ownerFieldWrites?: ReadonlyArray<OwnerFieldWriteIR>,
    storageKeyAccesses?: ReadonlyArray<StorageKeyAccessIR>,
    aiRawRuns?: ReadonlyArray<AiRawRunIR>,
    containerKeyAccesses?: ReadonlyArray<ContainerKeyAccessIR>,
    mailRecipientAccesses?: ReadonlyArray<MailRecipientAccessIR>,
    vectorNamespaceAccesses?: ReadonlyArray<VectorNamespaceAccessIR>,
    browserUrlAccesses?: ReadonlyArray<BrowserUrlAccessIR>,
    privilegedDispatches?: ReadonlyArray<PrivilegedDispatchIR>,
    containerOverrides?: ReadonlyArray<ContainerOverrideIR>,
    authConfigs?: ReadonlyArray<AuthConfigIR>,
    maskStrategies?: ReadonlyArray<MaskStrategyIR>,
    imageDeliveryUrlAccesses?: ReadonlyArray<ImageDeliveryUrlAccessIR>,
    ratelimitKeySelectors?: ReadonlyArray<RatelimitKeySelectorIR>,
): Finding[] =>
    runAdvisor(
        {
            adminRoutes,
            aiRawRuns,
            argumentDerivedFetches,
            argValidators: argumentValidators,
            authApiCalls,
            authConfigs,
            browserUrlAccesses,
            configCalls,
            containerKeyAccesses,
            containerOverrides,
            containers,
            imageDeliveryUrlAccesses,
            inserts,
            kvKeyAccesses,
            mailRecipientAccesses,
            maskProcedures,
            maskStrategies,
            mutatorWrites,
            nondeterministicCalls,
            ownerFieldWrites,
            privilegedDispatches,
            procedureProtections,
            queries,
            r2sqlCalls,
            ratelimitKeySelectors,
            rlsProcedures,
            schema: toAdvisorSchema(schema),
            secretLiterals,
            shapes: shapes === undefined ? undefined : toAdvisorShapes(shapes),
            sqlInterpolations,
            storageKeyAccesses,
            vectorNamespaceAccesses,
            workflowCalls,
            workflows,
        },
        { source: "static" },
    );

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
