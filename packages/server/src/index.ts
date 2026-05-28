export type { ActionDefinition, MutationDefinition, QueryDefinition } from "./functions.js";
export { action, mutation, query } from "./functions.js";
export type { TableBuilder } from "./schema.js";
export { defineSchema, defineTable } from "./schema.js";
export type {
    ActionCtx,
    AnyApi,
    ArgsValidator,
    AuthState,
    DatabaseReader,
    DatabaseWriter,
    FunctionKind,
    IndexDefinition,
    IndexRangeBuilder,
    InferArgs,
    MutationCtx,
    QueryCtx,
    ReadOnlyStorage,
    RegisteredAction,
    RegisteredFunction,
    RegisteredMutation,
    RegisteredQuery,
    Scheduler,
    Schema,
    SearchIndexDefinition,
    ShardMode,
    Storage,
    TableDefinition,
    TableReader,
} from "./types.js";
export { anyApi } from "./types.js";
export type { Id, Infer, Validator, ValidatorKind } from "@cirrus/values";
export { v } from "@cirrus/values";
export { ValidationError } from "@cirrus/values";

export const VERSION = "0.0.0";
