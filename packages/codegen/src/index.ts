// The snapshot format + diff are defined in the bundler-inlined `shared/` module
// (shared with `@lunora/studio`); re-exported here because this barrel is the
// package's published API and the CLI consumes them through it.
export type {
    DriftChange,
    DriftRemediation,
    DriftScope,
    FieldSnapshot,
    IndexSnapshot,
    RelationSnapshot,
    SchemaDrift,
    SchemaSnapshot,
    TableSnapshot,
} from "../../../shared/schema-snapshot";
export { diffSchemaSnapshots, SCHEMA_SNAPSHOT_VERSION, serializeSchemaSnapshot } from "../../../shared/schema-snapshot";
export type { LintSchemaOptions } from "./advisor";
export { formatAdvisories, lintSchema, toAdvisorContext } from "./advisor";
export { describeErrorLevelFindings, errorAdvisoryNames, errorPlatformDiagnosticNames } from "./blocking";
export { CodegenDiagnosticError, diagnosticAt } from "./diagnostics";
export { AGENTS_FILENAME, discoverAgents } from "./discover/agents";
// The canonical `lunora/` source walk — exported so a consumer deciding what
// codegen would read (the Vite plugin's schema fingerprint) walks the same set,
// symlinks and skips included, instead of forking the rules.
export { listLunoraSourceFiles } from "./discover/ast";
export { default as discoverAuthApiCalls } from "./discover/authapi-calls";
export { CONTAINERS_FILENAME, discoverContainers } from "./discover/containers";
export { default as discoverCrons } from "./discover/crons";
export { discoverFlags, FLAGS_FILENAME } from "./discover/flags";
export { default as discoverFunctions } from "./discover/functions";
export { default as discoverHttpRoutes } from "./discover/http-routes";
export { default as discoverHyperdriveCalls } from "./discover/hyperdrive-calls";
export { default as discoverInserts } from "./discover/inserts";
export { default as discoverMaskProcedures } from "./discover/mask-procedures";
export { default as discoverMigrations } from "./discover/migrations";
export { discoverMutators, MUTATORS_FILENAME } from "./discover/mutators";
export { default as discoverNondeterministicCalls } from "./discover/nondeterministic-calls";
export { discoverNotifyCalls, discoverNotifyConfig, NOTIFY_FILENAME } from "./discover/notify";
// Exported so the CLI's scaffolds pick the same import form codegen emits —
// `lunorash/server` for an umbrella project, `@lunora/server` otherwise.
// Returns `undefined` (not an empty set) for an absent/unparseable manifest, so
// a caller can tell "no dependencies declared" from "could not read".
export { default as readPackageDependencies } from "./discover/package-dependencies";
export { default as discoverQueries } from "./discover/queries";
export { discoverQueues, QUEUES_FILENAME } from "./discover/queues";
export { default as discoverR2sqlCalls } from "./discover/r2sql-calls";
export { default as discoverRlsProcedures } from "./discover/rls-procedures";
export { default as discoverRlsMetadata } from "./discover/rls-procedures/metadata";
export type { SandboxUsage } from "./discover/sandbox";
export { discoverSandboxUsage } from "./discover/sandbox";
export { default as discoverSchema } from "./discover/schema";
export { discoverShapes, SHAPES_FILENAME } from "./discover/shapes";
export { default as discoverStorageRulesMetadata } from "./discover/storage-rules";
export { discoverWorkflows, WORKFLOWS_FILENAME } from "./discover/workflows";
export {
    emitAgents,
    emitApi,
    emitCollections,
    emitContainers,
    emitCrons,
    emitDataModel,
    emitDrizzleSchema,
    emitFunctions,
    emitServer,
    emitShard,
    emitVectors,
    emitWorkflows,
    emitWranglerCronTriggers,
    GENERATED_HEADER,
} from "./emit";
export type { EmitAppOptions } from "./emit-app";
export { emitApp } from "./emit-app";
export type {
    AgentIR,
    AuthApiCallIR,
    ContainerIR,
    ContextPropertyCallIR,
    CronJobIR,
    FlagsIR,
    FunctionIR,
    HttpRouteIR,
    IndexIR,
    InsertWriteIR,
    MaskProcedureIR,
    MigrationIR,
    MutatorIR,
    ProjectIR,
    QueryReadIR,
    QueueIR,
    RlsMetadataIR,
    RlsPolicyIR,
    RlsProcedureIR,
    RlsRoleIR,
    SchemaIR,
    ShapeIR,
    StorageRuleIR,
    StorageRulesMetadataIR,
    TableIR,
    ValidatorIR,
    VectorIndexIR,
    WorkflowIR,
    WranglerVariableIR,
} from "./ir";
export type { OpenApiEmitInput } from "./openapi";
export { buildOpenApiDocument, emitOpenApi, emitOpenApiModule } from "./openapi";
export type { OpenRpcEmitInput } from "./openrpc";
export { buildOpenRpcDocument, emitOpenRpc, emitOpenRpcModule, OPENRPC_VERSION } from "./openrpc";
export type { PlatformDiagnostic } from "./platform-target";
export { DEFAULT_TARGET, platformMatrixIds, readProjectTarget, resolveCodegenTarget } from "./platform-target";
export type { CodegenOptions, CodegenResult } from "./run-codegen";
export { createCodegenProject, findTsconfig, refreshCodegenProject, runCodegen, SCHEMA_SNAPSHOT_FILENAME } from "./run-codegen";
export type { SchemaDriftDecision } from "./schema-drift";
export { buildSchemaSnapshot, evaluateSchemaDrift, parseSchemaSnapshot, SchemaSnapshotParseError } from "./schema-drift";
export { schemaFromIr } from "./schema-from-ir";
export { LUNORA_ERROR_CODES, validatorIrToJsonSchema } from "./schema-ir";
export type { OpenRpcDocument, OpenRpcMethod, RuntimeVerb, SdkFiles, SdkMethod, SdkNamespace, SdkRenderInput, SdkResult, SdkTarget } from "./sdk";
export { generateSdk, isTypedSchema, SDK_LANGUAGES, SDK_TARGETS } from "./sdk";
export { redact, secretKindOf } from "./secret-rules";
export type { LunoraSolution, LunoraSolutionRule } from "./solutions";
export { findLunoraSolution, LUNORA_SOLUTION_RULES } from "./solutions";
export type { Finding } from "@lunora/advisor";

export const VERSION = "0.0.0";
