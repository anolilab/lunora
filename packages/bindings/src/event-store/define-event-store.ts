/**
 * PROTOTYPE (plan 247, design spike) — see `packages/bindings/src/event-store/types.ts`
 * and `plans/247-event-store-design.md` for the design this validates.
 */
import { LunoraError } from "@lunora/errors";

import type { EventStore, EventStoreColumnType, EventStoreConfig, EventStoreRecord, EventStoreSchema } from "./types";

/** Runtime type check for one column value against its declared {@link EventStoreColumnType}. */
const matchesColumnType = (value: unknown, type: EventStoreColumnType): boolean => {
    switch (type) {
        case "boolean": {
            return typeof value === "boolean";
        }
        case "number": {
            return typeof value === "number" && Number.isFinite(value);
        }
        case "string": {
            return typeof value === "string";
        }
        case "timestamp": {
            return typeof value === "string" || typeof value === "number" || value instanceof Date;
        }
        default: {
            // Exhaustive per `EventStoreColumnType`; a value outside it (e.g. from
            // a plain-JS caller that bypassed the type system) fails closed.
            return false;
        }
    }
};

/**
 * Runtime guard behind `send()`. `EventStoreRecord&lt;Schema>` narrows the call
 * site at compile time, but Pipelines' own binding takes untyped
 * `Record&lt;string, unknown>[]` and enforces nothing server-side — so the type
 * alone is a promise a plain-JS caller, a stale build, or an `as` cast can
 * break silently. This is the actual enforcement: a record with a
 * wrong-typed field, a missing field, or a field the schema doesn't declare
 * throws here, before anything reaches Pipelines.
 */
const assertMatchesSchema = (schema: EventStoreSchema, record: Record<string, unknown>): void => {
    for (const [field, type] of Object.entries(schema)) {
        if (!matchesColumnType(record[field], type)) {
            throw new LunoraError("VALIDATION_ERROR", `@lunora/bindings/event-store: field "${field}" must be a ${type} (got ${typeof record[field]})`);
        }
    }

    for (const field of Object.keys(record)) {
        if (!(field in schema)) {
            throw new LunoraError("VALIDATION_ERROR", `@lunora/bindings/event-store: field "${field}" is not declared in the schema`);
        }
    }
};

/**
 * Declare one schema that types BOTH the Pipelines write path and the r2sql
 * read path over the same Iceberg table — modeled on `defineRag`
 * (`@lunora/ai/rag`), which couples `ctx.ai` + `ctx.vectors` under one schema
 * the same way. `send()` is runtime-validated against `schema`; `query()` is
 * `r2sql.from&lt;Row>(table)` with `Row` inferred from the same `schema`, so a
 * column can't drift between the two halves the way two hand-declared
 * column-type lists can.
 *
 * This is a SPIKE prototype: it does not own R2 Data Catalog table creation
 * (the table must already exist, matching `schema`, created out-of-band) and
 * is not wired into `@lunora/bindings`'s public subpath exports. See
 * `plans/247-event-store-design.md`.
 */
// eslint-disable-next-line import/prefer-default-export -- re-exported as a named export from index.ts; the package convention is named-only exports
export const defineEventStore = <Schema extends EventStoreSchema>(config: EventStoreConfig<Schema>): EventStore<Schema> => {
    const { pipeline, r2sql, schema, table } = config;

    return {
        query: () => r2sql.from<EventStoreRecord<Schema>>(table),
        send: async (record: EventStoreRecord<Schema>): Promise<void> => {
            assertMatchesSchema(schema, record);

            await pipeline.send([record]);
        },
    };
};
