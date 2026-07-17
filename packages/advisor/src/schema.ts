import type { Schema } from "@lunora/server";

/**
 * Normalized, feeder-agnostic view of a schema that lints run against. Both the
 * runtime `@lunora/server` {@link Schema} (record-shaped) and `@lunora/codegen`'s
 * `SchemaIR` (array-shaped, AST-derived) collapse to this same shape, so a lint
 * is written once and runs in either place. It carries only what the lints
 * read — tables, their columns, indexes, and relations.
 */
export interface AdvisorSchema {
    /**
     * Set when the schema opted into `.rls("required")` — every table's `ctx.db`
     * write path is denied without an RLS-covering procedure UNLESS the table
     * itself is `.public()` (see {@link AdvisorTable.isPublic}). `undefined` when
     * the schema never called `.rls("required")`. Read by the
     * `public_table_rls_optout_confusion` and `allow_unauthenticated_shard_access_enabled`
     * lints.
     */
    rlsMode?: "required";
    tables: ReadonlyArray<AdvisorTable>;
}

/** A table plus the column/index/relation metadata lints inspect. */
export interface AdvisorTable {
    /**
     * `true` when the table is written outside Lunora's discoverable insert path
     * — declared via `.externallyManaged()` (e.g. `@lunora/auth`'s better-auth
     * tables, `@lunora/ratelimit`'s store). Insert-path lints
     * (`table_without_insert`) skip such tables. Defaults to `false`.
     */
    externallyManaged?: boolean;

    /**
     * Set when the table was declared with `.source(...)` (plan 077) —
     * materialized from an external Hyperdrive-backed database. Read by the
     * `external_source_*` lints to enforce the tenant-scope boundary (mandatory
     * `tenantBy` under `.shardBy()`) and reject sourcing a `.global()` table.
     * Optional — feeders that don't know about sourced tables omit it.
     */
    externalSource?: AdvisorExternalSource;

    /**
     * Declared column names (the `defineTable({...})` keys). Excludes the
     * framework-managed system fields `_id` / `_creationTime`, which every table
     * has implicitly — lints that resolve a column treat those as always valid.
     */
    fields: ReadonlyArray<string>;
    /** Every declared index, across all kinds (secondary / search / rank / vector). */
    indexes: ReadonlyArray<AdvisorIndex>;

    /**
     * `true` when the table was declared with `.public()` — an explicit opt-OUT
     * of the schema's `.rls("required")` enforcement for this one table (the
     * name is misleading: it means "unprotected by RLS", not "safe to read
     * publicly"). Has no effect when the schema itself never required RLS.
     * Defaults to `false`. Read by `public_table_rls_optout_confusion` and
     * `allow_unauthenticated_shard_access_enabled`.
     */
    isPublic?: boolean;
    /** Table name. */
    name: string;

    /**
     * Column names that are optional or nullable and therefore may legally hold
     * `null` / `undefined` in stored rows. Populated by {@link fromServerSchema}
     * from the runtime validator graph (`v.optional(...)` → kind `"optional"`;
     * `.nullable()` → `column.notNull === false`). When absent (e.g. from the
     * codegen feeder, which does not supply this field), constraint lints that
     * check NOT NULL should skip the check entirely or treat every field as
     * required (the codegen feeder never runs runtime lints anyway).
     */
    optionalFields?: ReadonlySet<string>;
    /** Declared relations (`.relations((r) => …)`). */
    relations: ReadonlyArray<AdvisorRelation>;

    /**
     * Storage tier the table is declared in: `"global"` (a `.global()` table,
     * lives in D1 — the cross-shard tier), `"shardBy"` (partitioned across
     * shard DOs by a key), or `"root"` (the default single-DO table). Read by
     * the `shape_*` lints to flag replication shapes targeting a `.global()`
     * table (poll-refreshed/latency-tiered, not poke-live). Optional — the
     * codegen feeder always supplies it, the runtime feeder derives it; a feeder
     * that omits it leaves tier-sensitive lints to treat the table as local.
     */
    shardKind?: "global" | "root" | "shardBy";

    /**
     * Set when the table opted into `.softDelete()` — the marker column
     * (`field`, default `deletedAt`) whose presence excludes a row from list
     * reads unless `includeDeleted: true` is passed. Read by
     * `soft_delete_include_deleted_from_args` to confirm a read's target actually
     * soft-deletes before flagging an `includeDeleted` toggle on a public read.
     * Optional — a feeder that doesn't track soft-delete omits it.
     */
    softDelete?: { field: string };
}

/**
 * One declared index, flattened across Lunora's index kinds so a single lint can
 * reason about every column an index touches. `kind` distinguishes the DSL that
 * declared it — only `index` (a btree secondary index) covers a foreign-key
 * equality lookup, so the FK lint filters on it. `fields` is every column the
 * index references (a secondary index's columns; a search index's text +
 * filter fields; a rank index's sort + partition fields; a vector index's
 * source field). `unique` is set only for unique secondary indexes.
 */
export interface AdvisorIndex {
    fields: ReadonlyArray<string>;
    kind: "index" | "rank" | "search" | "vector";
    name: string;
    unique?: boolean;
}

/** The statically-knowable `.source(...)` bits the `external_source_*` lints read. */
export interface AdvisorExternalSource {
    /** `true` when a `reconcileEveryMs` was given — reserved for a future incremental mode's delete-visibility lint; not on the typed `.source()` surface today. */
    hasReconcile?: boolean;
    /** `true` when a `tenantBy` mapper was given — the tenant-isolation boundary. */
    hasTenantBy: boolean;
    /** Delete-detection mode literal, when given (`"full-pull"` today). */
    mode?: string;

    /**
     * `true` when `.source(...)` was declared but its config wasn't a static object
     * literal, so `hasTenantBy` (and the rest) couldn't be read. Only the codegen
     * feeder can hit this; the runtime feeder always holds the real config.
     */
    unanalyzable?: boolean;
}

/**
 * One declared relation. For a `one` relation the FK column `field` lives on
 * the holding table; for `many` it lives on the target. `name` is the accessor
 * the relation is loaded under.
 */
export interface AdvisorRelation {
    field: string;
    kind: "many" | "one";
    name: string;
    onDelete?: "cascade" | "restrict" | "set null";
    references: string;
    table: string;
}

/**
 * Adapt the runtime `@lunora/server` {@link Schema} into an {@link AdvisorSchema}.
 * Runtime callers (the studio backend, a live shard) hold the real schema
 * object; this collapses its record-keyed `tables`/`relationMap` into the array
 * form lints consume and flattens the per-kind index arrays into one list. The
 * codegen feeder builds the same shape from its AST IR independently (it never
 * imports `@lunora/server`).
 */
export const fromServerSchema = (schema: Schema): AdvisorSchema => {
    return {
        rlsMode: schema.rlsMode,
        tables: Object.entries(schema.tables).map(([name, table]) => {
            const indexes: AdvisorIndex[] = [
                ...table.indexes.map((index): AdvisorIndex => {
                    return { fields: index.fields, kind: "index", name: index.name, unique: index.unique };
                }),
                ...table.searchIndexes.map((index): AdvisorIndex => {
                    return { fields: [index.field, ...(index.filterFields ?? [])], kind: "search", name: index.name };
                }),
                ...table.rankIndexes.map((index): AdvisorIndex => {
                    return { fields: [...index.sortBy.map((key) => key.field), ...(index.partitionBy ?? [])], kind: "rank", name: index.name };
                }),
                ...table.vectorIndexes.map((index): AdvisorIndex => {
                    return { fields: [index.field], kind: "vector", name: index.name };
                }),
            ];

            // Collect optional/nullable field names so the constraint-validator
            // can skip them when checking NOT NULL. A field is optional when its
            // validator kind is "optional" (v.optional(inner)) or nullable when
            // its column.notNull flag is false (inner.nullable()).
            const optionalFields = new Set<string>();

            for (const [fieldName, validator] of Object.entries(table.shape)) {
                if (validator.kind === "optional") {
                    optionalFields.add(fieldName);
                } else {
                    // Access the internal _meta.column shape that the runtime
                    // validator carries. This is an internal implementation
                    // detail of @lunora/values — the cast is intentional and
                    // matches the same pattern used in isOrWrapsFromValidator.
                    const column = (validator as { _meta?: { column?: { notNull?: boolean } } })._meta?.column;

                    if (column?.notNull === false) {
                        optionalFields.add(fieldName);
                    }
                }
            }

            return {
                externallyManaged: table.isExternallyManaged ?? false,
                externalSource: table.externalSource
                    ? {
                          // `reconcileEveryMs` is not on the typed `.source()`
                          // surface today; read it through a widening cast so an
                          // untyped JS schema that still carries the key feeds the IR
                          // the same way the AST feeder does.
                          hasReconcile: (table.externalSource as { reconcileEveryMs?: number }).reconcileEveryMs !== undefined,
                          hasTenantBy: table.externalSource.tenantBy !== undefined,
                          mode: table.externalSource.mode,
                      }
                    : undefined,
                fields: Object.keys(table.shape),
                indexes,
                isPublic: table.isPublic ?? false,
                name,
                optionalFields,
                shardKind: table.shardMode.kind,
                softDelete: table.softDeleteMode,
                relations: Object.entries(table.relationMap).map(([accessor, relation]) => {
                    return {
                        field: relation.field,
                        kind: relation.kind,
                        name: accessor,
                        onDelete: relation.onDelete,
                        references: relation.references,
                        table: relation.table,
                    };
                }),
            };
        }),
    };
};
