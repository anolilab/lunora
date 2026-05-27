export { discoverFunctions } from "./discoverFunctions.js";
export { discoverSchema } from "./discoverSchema.js";
export { emitApi, emitDataModel, emitServer, GENERATED_HEADER } from "./emit.js";
export type { FunctionIR, IndexIR, ProjectIR, SchemaIR, TableIR, ValidatorIR } from "./ir.js";
export { runCodegen } from "./runCodegen.js";
export type { CodegenOptions, CodegenResult } from "./runCodegen.js";

export const VERSION = "0.0.0";
