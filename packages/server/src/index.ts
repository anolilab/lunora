export type {
    ActionBuilder,
    CirrusBuilders,
    CreateOptions,
    DataModelInit,
    EmptyArgs,
    Middleware,
    MiddlewareNext,
    MutationBuilder,
    QueryBuilder,
    TerminalKind,
} from "./builder/index.js";
export { initCirrus } from "./builder/index.js";
export type { CirrusErrorCode } from "./error.js";
export { CirrusError } from "./error.js";
export type { ActionDefinition, MutationDefinition, QueryDefinition } from "./functions.js";
export { action, mutation, query } from "./functions.js";
export type { ManyRelation, OneRelation, RelationBuilder, TableBuilder, VectorIndexOptions, VectorizeOptions } from "./schema.js";
export { defineSchema, defineTable, defineVectorIndex } from "./schema.js";
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
    OnDeleteAction,
    QueryCtx,
    ReadOnlyStorage,
    RegisteredAction,
    RegisteredFunction,
    RegisteredMutation,
    RegisteredQuery,
    RelationDefinition,
    Scheduler,
    Schema,
    SearchIndexDefinition,
    ShardMode,
    Storage,
    TableDefinition,
    TableReader,
    TableVectorIndex,
    TriggerBuilder,
    TriggerCtx,
    TriggerDatabase,
    TriggerDefinition,
    TriggerDeleteEvent,
    TriggerEvent,
    TriggerHandler,
    TriggerInsertEvent,
    TriggerOp,
    TriggerQueryArgs,
    TriggerQueryPage,
    TriggerRow,
    TriggerTiming,
    TriggerUpdateEvent,
    VectorEmbedder,
    VectorIndexDefinition,
    VectorMatch,
    VectorMatches,
    VectorMetric,
    VectorQueryInput,
    VectorRecord,
    VectorSearch,
    VectorSearchReader,
    VectorUpsertInput,
} from "./types.js";
export { anyApi } from "./types.js";
export type { Id, Infer, Validator, ValidatorKind } from "@cirrus/values";
export { v } from "@cirrus/values";
export { ValidationError } from "@cirrus/values";

export const VERSION = "0.0.0";
