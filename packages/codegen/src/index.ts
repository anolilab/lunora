export { formatAdvisories, lintSchema } from "./advisor";
export { CodegenDiagnosticError, diagnosticAt } from "./diagnostics";
export { default as discoverAuthApiCalls } from "./discover-authapi-calls";
export { CONTAINERS_FILENAME, discoverContainers } from "./discover-containers";
export { default as discoverCrons } from "./discover-crons";
export { discoverFunctions } from "./discover-functions";
export { default as discoverHttpRoutes } from "./discover-http-routes";
export { default as discoverInserts } from "./discover-inserts";
export { default as discoverMigrations } from "./discover-migrations";
export { default as discoverQueries } from "./discover-queries";
export { discoverRlsMetadata, default as discoverRlsProcedures } from "./discover-rls-procedures";
export { default as discoverSchema } from "./discover-schema";
export { default as discoverStorageRulesMetadata } from "./discover-storage-rules";
export {
    emitApi,
    emitContainers,
    emitCrons,
    emitDataModel,
    emitDrizzleSchema,
    emitFunctions,
    emitServer,
    emitShard,
    emitVectors,
    emitWranglerCronTriggers,
    GENERATED_HEADER,
} from "./emit";
export type {
    AuthApiCallIR,
    ContainerIR,
    CronJobIR,
    FunctionIR,
    HttpRouteIR,
    IndexIR,
    InsertWriteIR,
    MigrationIR,
    ProjectIR,
    QueryReadIR,
    RlsMetadataIR,
    RlsPolicyIR,
    RlsProcedureIR,
    RlsRoleIR,
    SchemaIR,
    StorageRuleIR,
    StorageRulesMetadataIR,
    TableIR,
    ValidatorIR,
    VectorIndexIR,
} from "./ir";
export type { OpenApiEmitInput } from "./openapi";
export { buildOpenApiDocument, emitOpenApi, emitOpenApiModule } from "./openapi";
export type { OpenRpcEmitInput } from "./openrpc";
export { buildOpenRpcDocument, emitOpenRpc, emitOpenRpcModule, OPENRPC_VERSION } from "./openrpc";
export type { CodegenOptions, CodegenResult } from "./run-codegen";
export { createCodegenProject, refreshCodegenProject, runCodegen, SCHEMA_SNAPSHOT_FILENAME } from "./run-codegen";
export type {
    DriftChange,
    FieldSnapshot,
    IndexSnapshot,
    RelationSnapshot,
    SchemaDrift,
    SchemaDriftDecision,
    SchemaSnapshot,
    TableSnapshot,
} from "./schema-drift";
export {
    buildSchemaSnapshot,
    diffSchemaSnapshots,
    evaluateSchemaDrift,
    parseSchemaSnapshot,
    SCHEMA_SNAPSHOT_VERSION,
    SchemaSnapshotParseError,
    serializeSchemaSnapshot,
} from "./schema-drift";
export { CIRRUS_ERROR_CODES, validatorIrToJsonSchema } from "./schema-ir";
export type { Finding } from "@cirrus/advisor";

export const VERSION = "0.0.0";
