// `external-source-cursor` is an internal ingest detail (the durable watermark
// codec + reserved-table helpers), consumed only by `external-source-pull` and its
// own tests — not re-exported, mirroring `external-source-diff`'s module-private
// `projectExternalSourceRow`.
export { serveRelationFanout } from "./relation-fanout";
// The search core moved out of this package. It used to be re-exported from
// here so `@lunora/sql-store` could reuse it, which turned two dozen internal
// contracts into permanent public API for no reason other than cross-package
// reach. `guardWriter` left for the same reason and now lives in
// `@lunora/shard-engine`, which re-exports it.
export type { SessionRecord } from "./session-do";
export { SESSION_DO_TTL_DEFAULT, SessionDO } from "./session-do";
export type {
    HibernatableWebSocket,
    LogSink,
    RunShardApplyCdcArgs,
    RunShardApplyCdcResult,
    RunShardBulkDeleteArgs,
    RunShardBulkDeleteResult,
    RunShardExportArgs,
    RunShardImportArgs,
    RunShardMigrationArgs,
    RunShardRankBeforeArgs,
    RunShardRankPageArgs,
    RunShardWriteArgs,
    RunShardWriteResult,
    ShardDOOptions,
    ShardDOState,
    SubscriptionOutcome,
    TelemetrySink,
} from "./shard-do";
export { ROOT_DO_SIZE_WARN_BYTES, ROOT_SHARD_NAME, ShardDO, subscriptionListDeltas } from "./shard-do";
export { SHARD_REGISTRY_DO_NAME, ShardRegistryDO } from "./shard-registry-do";
// Cloudflare implementations of the `@lunora/platform` host contracts. These
// are what `@lunora/platform-cloudflare` will re-export as the default host.
export { createShardAlarms, createShardDirectory, createShardHost, createShardKvStore, createSocketHost } from "@lunora/platform-cloudflare";
// The Cloudflare composition root: every `@lunora/platform` contract assembled
// from the two lifetimes a Worker has (DO state, worker env).
export type { ShardPlatform, WorkerPlatform, WorkerPlatformOptions } from "@lunora/platform-cloudflare";
export { createShardPlatform, createWorkerPlatform } from "@lunora/platform-cloudflare";

// Every re-export below must have a named consumer (the codegen emitter's
// import builders, or an import site in this repo). Additions require one;
// drive-by re-exports are how 230 unused names got frozen here (plan 286).
//
// The 237 that had no consumer were removed; everything they named is still
// exported by `@lunora/shard-engine`, which is where to import it from.
export type { ExportRow, ImportShardResult } from "@lunora/shard-engine";
export type { DataMigrationLike, MigrationRunResult } from "@lunora/shard-engine";
export type { KeyRange } from "@lunora/shard-engine";
export type { TransactionHeadroomTracker } from "@lunora/shard-engine";
export type { DatabaseWriterLike, SchemaLike, SqlExec, ValidatorLike, WriteHook } from "@lunora/shard-engine";
export type {
    AdvisorProcedure,
    AdvisoryFinding,
    FlagsResult,
    MaskPoliciesResult,
    QueuesResult,
    RlsPoliciesResult,
    StorageRulesResult,
    StudioFeaturesResult,
    WorkflowsResult,
} from "@lunora/shard-engine";
export type { SystemReaderStorageLike } from "@lunora/shard-engine";
export type { SchedulerLike } from "@lunora/shard-engine";
export type { AggregateIndexDefinitionLike } from "@lunora/shard-engine";
export type { RankIndexDefinitionLike, ShardRankPageResult } from "@lunora/shard-engine";
export type { MutationDelta } from "@lunora/shard-engine";
export { createReadFootprint } from "@lunora/shard-engine";
export { exportShardRows, importShardRows } from "@lunora/shard-engine";
export { runDataMigration } from "@lunora/shard-engine";
export { buildReprojectionMigration, countLegacyRows, REPROJECTION_MIGRATION_PREFIX, reprojectionMigrationId, reprojectionTables } from "@lunora/shard-engine";
export { isSourceDue, pullExternalSourceIncrementalTick, pullExternalSourceTick } from "@lunora/shard-engine";
export { applyCdcChanges, createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
export { assertShapeShardable } from "@lunora/shard-engine";

// Emitter-conditional: the generated shard imports `WhereInput` when the project
// declares shapes and the two source `*Like`s when it declares `.source()` tables
// (`packages/codegen/src/emit.ts:4204`, `:4300`).
export type { ExternalSourceLike, SourceClientLike, WhereInput } from "@lunora/shard-engine";

// Observability is NOT re-exported from here. It lives in `@lunora/observability`
// and consumers import it from there directly.
//
// Re-exporting it would put this package back in the middle of a dependency it
// does not own: every symbol that package adds would silently widen this one's
// frozen surface, and a second host would reach telemetry *through* the
// Cloudflare package — the exact coupling the extraction removed.
// The reactive engine lives in `@lunora/shard-engine` (host-neutral: it touches
// only SQL and the schema, never a Durable Object). Only the names codegen emits
// against are re-exported here — plan 114 §5.2's freeze covers that emitted set,
// not the engine's whole barrel.
