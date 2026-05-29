export { discoverFunctions } from "./discover-functions.js";
export { discoverMigrations } from "./discover-migrations.js";
export { discoverSchema } from "./discover-schema.js";
export { emitApi, emitDataModel, emitDrizzleSchema, emitServer, emitShard, GENERATED_HEADER } from "./emit.js";
export type { FunctionIR, IndexIR, MigrationIR, ProjectIR, SchemaIR, TableIR, ValidatorIR, VectorIndexIR } from "./ir.js";
export type { CodegenOptions, CodegenResult } from "./run-codegen.js";
export { runCodegen } from "./run-codegen.js";

export const VERSION = "0.0.0";
