/**
 * PROTOTYPE (plan 247, design spike) — types for `defineEventStore`, which
 * explores whether one declared schema can drive BOTH the Pipelines write
 * path (`ctx.pipelines`-shaped `.send()`) and the r2sql read path
 * (`ctx.r2sql`-shaped `.query()`) over the same R2 Data Catalog / Iceberg
 * table, the way `defineRag` (`@lunora/ai/rag`) already couples `ctx.ai` +
 * `ctx.vectors` under one schema.
 *
 * Not wired into the package's public subpath exports — see
 * `plans/247-event-store-design.md` for the open questions (table-lifecycle
 * ownership, Analytics Engine generalization, codegen wiring) that block
 * shipping this as `@lunora/bindings/event-store`.
 */

import type { PipelineBindingLike } from "../pipelines/types";
import type SelectBuilder from "../r2sql/builder";
import type { R2SqlClient } from "../r2sql/client";

/**
 * Column primitive types this prototype supports. Deliberately small — enough
 * to prove the schema-drives-both-halves mapping, not a full mirror of
 * Iceberg's type system (no nested/list/map/decimal types). A real
 * implementation would need to grow this to whatever the R2 Data Catalog
 * table actually declares.
 */
type EventStoreColumnType = "boolean" | "number" | "string" | "timestamp";

/** Map one {@link EventStoreColumnType} to its TS representation. */
type TsTypeOfColumn<Column extends EventStoreColumnType> = Column extends "boolean"
    ? boolean
    : Column extends "number"
      ? number
      : Column extends "string"
        ? string
        : Column extends "timestamp"
          ? Date | number | string
          : never;

/**
 * A column name → type map. This one object is the schema: it drives both
 * `send()`'s accepted record type and `query()`'s row type, so the two
 * can't independently drift the way two hand-written column-type lists can.
 */
type EventStoreSchema = Record<string, EventStoreColumnType>;

/**
 * The record shape `send()` accepts and `query()`'s rows resolve to, derived
 * field-by-field from `Schema`.
 */
type EventStoreRecord<Schema extends EventStoreSchema> = { [Field in keyof Schema]: TsTypeOfColumn<Schema[Field]> };

/** Config for {@link import("./define-event-store").defineEventStore | defineEventStore}. */
interface EventStoreConfig<Schema extends EventStoreSchema> {
    /**
     * The Pipelines binding-like `send()` is forwarded to (the same shape
     * `ctx.pipelines` wraps — see `@lunora/bindings/pipelines`'s
     * `PipelineBindingLike`). Untyped at the Cloudflare API boundary; this
     * prototype's `EventStoreRecord&lt;Schema>` narrows the call site.
     */
    pipeline: PipelineBindingLike<EventStoreRecord<Schema>>;

    /**
     * The r2sql client `query()` is built from (the same shape `ctx.r2sql`
     * wraps — see `@lunora/bindings/r2sql`'s `R2SqlClient`). Only `from` is
     * required, so a caller can inject a narrower double in tests.
     */
    r2sql: Pick<R2SqlClient, "from">;

    /**
     * Column name → type. The single source of truth this prototype exists
     * to prove: it drives both `send()`'s record type and `query()`'s row
     * type from the SAME declaration, instead of two independently
     * maintained lists.
     */
    schema: Schema;

    /**
     * The Iceberg table (`namespace.table`) both halves target. **Not owned
     * by this prototype** — see the design doc's "document, don't own"
     * decision: the table must already exist, with a schema matching
     * `schema`, created out-of-band (`wrangler r2 sql` / R2 Data Catalog API
     * / Cloudflare dashboard) and kept in sync by hand.
     */
    table: string;
}

/** Returned by {@link import("./define-event-store").defineEventStore | defineEventStore}. */
interface EventStore<Schema extends EventStoreSchema> {
    /**
     * Start a typed r2sql `SELECT` over the same table + schema — literally
     * `r2sql.from&lt;EventStoreRecord&lt;Schema>>(table)`, so it inherits every
     * `SelectBuilder` feature (`WHERE`, joins, window functions, set
     * operations, …) for free; this prototype adds no query surface of its
     * own.
     */
    query: () => SelectBuilder<EventStoreRecord<Schema>>;

    /**
     * Ingest one record through Pipelines. Runtime-validated against
     * `schema` before the record reaches the binding — Pipelines ingest is
     * otherwise fire-and-forget with zero server-side schema enforcement
     * (see the design doc), so `EventStoreRecord&lt;Schema>` alone would only be
     * a compile-time promise a plain-JS caller (or an `as` cast) could break
     * silently.
     */
    send: (record: EventStoreRecord<Schema>) => Promise<void>;
}

export type { EventStore, EventStoreColumnType, EventStoreConfig, EventStoreRecord, EventStoreSchema };
