export type {
    ActionBuilder,
    CirrusBuilders,
    CreateOptions,
    DataModelInit,
    EmptyArgs,
    InternalActionBuilder,
    InternalMutationBuilder,
    InternalQueryBuilder,
    Middleware,
    MiddlewareNext,
    MutationBuilder,
    QueryBuilder,
    TerminalKind,
} from "./builder/index.js";
export { initCirrus } from "./builder/index.js";
export type { CirrusErrorCode } from "./error.js";
export { CirrusError } from "./error.js";
export type { FacadeEntry, FacadeWriterLike, OrmLike } from "./facade.js";
export { bindOrm, bindTableFacade } from "./facade.js";
export type { ActionDefinition, MutationDefinition, QueryDefinition } from "./functions.js";
export { action, internalAction, internalMutation, internalQuery, mutation, query } from "./functions.js";
export type {
    CirrusHttpApp,
    CirrusHttpEnv,
    CirrusRouteHandler,
    HttpActionCtx,
    HttpActionHandler,
    HttpMethod,
    HttpRoute,
    HttpRouteBuilder,
    HttpRouteFactory,
    HttpRouteHandlerOptions,
    HttpStreamHandlerOptions,
} from "./http.js";
export { httpAction, httpRoute, httpRouter, serveStorageObject } from "./http.js";
export type { MigrationDefinition, MigrationDocument, MigrationTransform, RegisteredMigration } from "./migration.js";
export { defineMigration } from "./migration.js";
export type { Component, ComponentFunctions, DefineComponentOptions, DefinePluginOptions, Plugin, PrefixedTables, SchemaExtension } from "./plugin.js";
export { composePluginMiddleware, defineComponent, definePlugin, defineSchemaExtension, installPlugins, mergeSchemaExtension } from "./plugin.js";
export type { DefinePresenceOptions, PresenceComponent, PresenceFunctions, PresenceMember } from "./presence.js";
export { definePresence, PRESENCE_DEFAULT_TTL_MS, PRESENCE_TABLE, presenceExtension } from "./presence.js";
export type { DefinePolicyInput, Permission, Policy, PolicyContext, PolicyDecision, PolicyOperation, RlsOptions, Role, WhereInput } from "./rls/index.js";
export { definePermission, definePolicies, definePolicy, defineRole, rls } from "./rls/index.js";
export type {
    AggregateIndexOptions,
    ExtendableSchema,
    InlineAggregateIndexOptions,
    InlineRankIndexOptions,
    ManyRelation,
    OneRelation,
    RankIndexOptions,
    RelationBuilder,
    TableBuilder,
    VectorIndexOptions,
    VectorizeOptions,
} from "./schema.js";
export { defineAggregateIndex, defineRankIndex, defineSchema, defineTable, defineVectorIndex } from "./schema.js";
export type {
    ActionCtx,
    AggregateIndexDefinition,
    AggregateOp,
    AnyApi,
    ArgsValidator,
    AuthState,
    DatabaseReader,
    DatabaseWriter,
    FunctionKind,
    FunctionVisibility,
    IndexDefinition,
    IndexRangeBuilder,
    InferArgs,
    MutationCtx,
    OnDeleteAction,
    PaginationOptions,
    PaginationResult,
    QueryCtx,
    RankIndexDefinition,
    RankSortKey,
    ReadOnlyStorage,
    RegisteredAction,
    RegisteredFunction,
    RegisteredMutation,
    RegisteredQuery,
    RegisteredStream,
    RelationDefinition,
    ScheduledFunctionDoc,
    ScheduledJob,
    Scheduler,
    Schema,
    SearchFilterBuilder,
    SearchIndexDefinition,
    ShardMode,
    Storage,
    StorageMetadata,
    SystemDatabaseReader,
    SystemDoc,
    SystemQuery,
    SystemTableName,
    TableDefinition,
    TableReader,
    TableVectorIndex,
    TriggerAggregateOptions,
    TriggerBuilder,
    TriggerCtx,
    TriggerDatabase,
    TriggerDefinition,
    TriggerDeleteEvent,
    TriggerEvent,
    TriggerGroupByEntry,
    TriggerGroupByOptions,
    TriggerHandler,
    TriggerInsertEvent,
    TriggerOp,
    TriggerQueryArgs,
    TriggerQueryPage,
    TriggerRankOptions,
    TriggerRankPageOptions,
    TriggerRankResult,
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
// Re-export the code-first cron builder so users declare crons from the main
// package alongside query/mutation/action (it lives in @cirrus/scheduler).
export type { CronJob, CronJobsBuilder, CronScheduleKind, DailySchedule, IntervalSchedule, MonthlySchedule, WeeklySchedule } from "@cirrus/scheduler";
export { cronJobs } from "@cirrus/scheduler";
export type { ColumnValidator, Id, Infer, Validator, ValidatorKind } from "@cirrus/values";
export { v } from "@cirrus/values";
export { ValidationError } from "@cirrus/values";

export const VERSION = "0.0.0";
