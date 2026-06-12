export { formatAdvisories, lintSchema } from "./advisor";
export { CodegenDiagnosticError, diagnosticAt } from "./diagnostics";
export { default as discoverAuthApiCalls } from "./discover-authapi-calls";
export { default as discoverCrons } from "./discover-crons";
export { discoverFunctions } from "./discover-functions";
export { default as discoverHttpRoutes } from "./discover-http-routes";
export { default as discoverInserts } from "./discover-inserts";
export { default as discoverMigrations } from "./discover-migrations";
export { default as discoverQueries } from "./discover-queries";
export { discoverRlsMetadata, default as discoverRlsProcedures } from "./discover-rls-procedures";
export { default as discoverSchema } from "./discover-schema";
export { emitApi, emitCrons, emitDataModel, emitDrizzleSchema, emitFunctions, emitServer, emitShard, emitWranglerCronTriggers, GENERATED_HEADER } from "./emit";
export type {
    AuthApiCallIR,
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
    TableIR,
    ValidatorIR,
    VectorIndexIR,
} from "./ir";
export type { OpenApiEmitInput } from "./openapi";
export { buildOpenApiDocument, emitOpenApi, emitOpenApiModule } from "./openapi";
export type { OpenRpcEmitInput } from "./openrpc";
export { buildOpenRpcDocument, emitOpenRpc, emitOpenRpcModule, OPENRPC_VERSION } from "./openrpc";
export type { CodegenOptions, CodegenResult } from "./run-codegen";
export { runCodegen } from "./run-codegen";
export { CIRRUS_ERROR_CODES, validatorIrToJsonSchema } from "./schema-ir";
export type { Finding } from "@cirrus/advisor";

export const VERSION = "0.0.0";
