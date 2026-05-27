import type { Validator } from "@cirrus/values";

import type { IndexDefinition, Schema, SearchIndexDefinition, ShardMode, TableDefinition } from "./types.js";

export interface TableBuilder<Shape extends Record<string, Validator> = Record<string, Validator>> extends TableDefinition<Shape> {
    /** Mark this table as global (D1-backed, cross-shard). */
    global(): TableBuilder<Shape>;
    /** Add a secondary index. */
    index(name: string, fields: ReadonlyArray<string>, options?: { unique?: boolean }): TableBuilder<Shape>;
    /** Add a search index over a field with optional filter fields. */
    searchIndex(name: string, options: { field: string; filterFields?: ReadonlyArray<string> }): TableBuilder<Shape>;
    /** Route storage by the named field — one DO per distinct value. */
    shardBy(field: keyof Shape & string): TableBuilder<Shape>;
}

/**
 * Build a table definition. Returned object is both the table definition (for
 * `defineSchema`) and a fluent builder for indexes + sharding metadata.
 */
export const defineTable = <Shape extends Record<string, Validator>>(shape: Shape): TableBuilder<Shape> => {
    const indexes: IndexDefinition[] = [];
    const searchIndexes: SearchIndexDefinition[] = [];
    let shardMode: ShardMode = { kind: "root" };

    const builder: TableBuilder<Shape> = {
        get indexes() {
            return indexes;
        },
        get searchIndexes() {
            return searchIndexes;
        },
        shape,
        get shardMode() {
            return shardMode;
        },
        global() {
            shardMode = { kind: "global" };

            return builder;
        },
        index(name, fields, options) {
            indexes.push({ fields, name, unique: options?.unique ?? false });

            return builder;
        },
        searchIndex(name, options) {
            searchIndexes.push({ field: options.field, filterFields: options.filterFields, name });

            return builder;
        },
        shardBy(field) {
            shardMode = { field, kind: "shardBy" };

            return builder;
        },
    };

    return builder;
};

/**
 * Build the application schema. Accepts a record of named tables.
 */
export const defineSchema = <T extends Record<string, TableDefinition>>(tables: T): Schema<T> => {
    return { tables };
};
