import type { SchemaIR } from "../ir";
import { rebaseRelativeQualifiers, relocateUserRelativeImports } from "./qualifiers";
import { assertIdentifier, GENERATED_HEADER, renderInsertInterface, renderPropertyKey, validatorToType } from "./shared";

/**
 * Lunora-relative path of the module column validators are read from. Schema
 * discovery always parses `lunora/schema.ts`, so a relative `import("…")`
 * qualifier in a column's rendered type is relative to that file — which is what
 * {@link relocateUserRelativeImports} rebases against.
 */
const SCHEMA_MODULE_PATH = "schema";

/** Emit `_generated/dataModel.ts` — `Doc<"name">` + `Id<"name">` for every table. */
const emitDataModel = (schema: SchemaIR): string => {
    for (const table of schema.tables) {
        assertIdentifier(table.name, "table name");
    }

    const tableNames = schema.tables.map((table) => `"${table.name}"`).join(" | ") || "never";
    // Tables the app declared itself — an add-on's `.extend(...)` contributions are
    // excluded. See the `AppTableName` doc in the emitted output.
    const appTableNames =
        schema.tables
            .filter((table) => table.extensionKey === undefined)
            .map((table) => `"${table.name}"`)
            .join(" | ") || "never";

    const documents = schema.tables
        .map((table) => {
            const fields = Object.entries(table.shape)
                .map(([fieldName, validator]) => {
                    const propertyKey = renderPropertyKey(fieldName);

                    if (validator.kind === "optional") {
                        const inner = validator.inner ? validatorToType(validator.inner) : "unknown";

                        return `    ${propertyKey}?: ${inner};`;
                    }

                    return `    ${propertyKey}: ${validatorToType(validator)};`;
                })
                .join("\n");
            const body = fields ? `\n${fields}\n` : "";

            // `_commitSeq` is minted by the write path on a `.commitOrdered()`
            // table only, so it is rendered per-table rather than alongside the
            // two unconditional system fields.
            const commitSeq = table.commitOrdered === true ? "\n    _commitSeq: number;" : "";

            return `export interface Doc_${table.name} {\n    _id: Id<"${table.name}">;\n    _creationTime: number;${commitSeq}${body}}`;
        })
        .join("\n\n");

    const documentMap = schema.tables.map((table) => `    ${table.name}: Doc_${table.name};`).join("\n");

    // Per-table index name union — surfaced as `IndexName<"messages">` so
    // `TableReader.withIndex(name)` can be typed without a hand-rolled
    // overload per table.
    const indexNamesByTable = schema.tables
        .map((table) => {
            const names = table.indexes
                // Index names are emitted as string-literal members of a union
                // type, so they may legitimately be non-identifiers (e.g.
                // "by-author"). JSON.stringify quotes + escapes them safely,
                // which closes the injection vector without rejecting hyphens.
                .map((index) => JSON.stringify(index.name))
                .join(" | ");

            return `    ${table.name}: ${names || "never"};`;
        })
        .join("\n");

    const searchIndexNamesByTable = schema.tables
        .map((table) => {
            const names = table.searchIndexes.map((index) => JSON.stringify(index.name)).join(" | ");

            return `    ${table.name}: ${names || "never"};`;
        })
        .join("\n");

    const rankIndexNamesByTable = schema.tables
        .map((table) => {
            const names = table.rankIndexes.map((index) => JSON.stringify(index.name)).join(" | ");

            return `    ${table.name}: ${names || "never"};`;
        })
        .join("\n");

    const geoIndexNamesByTable = schema.tables
        .map((table) => {
            // Like search, geo queries route through the local DO reader; a
            // `.global()` (D1) table has no geohash companion, so emit `never`.
            const names = table.shardMode === "global" ? "" : (table.geoIndexes ?? []).map((index) => JSON.stringify(index.name)).join(" | ");

            return `    ${table.name}: ${names || "never"};`;
        })
        .join("\n");

    const vectorIndexNames = schema.vectorIndexes.map((index) => JSON.stringify(index.name)).join(" | ") || "never";

    const insertInterfaces = schema.tables.map((table) => renderInsertInterface(table)).join("\n\n");
    const insertMap = schema.tables.map((table) => `    ${table.name}: Insert_${table.name};`).join("\n");

    // Per-table relation descriptor map. Every table gets an entry (`{}` when it
    // declares none) so `Relations[T]` is always defined for the `with` machinery.
    const relationsMap = schema.tables
        .map((table) => {
            const entries = table.relations
                .map((relation) => {
                    // The target table name is interpolated into a `<"...">` type
                    // argument, so it must be a valid identifier like every other
                    // table name. The accessor name becomes a property key — route
                    // it through `renderPropertyKey` so a non-identifier accessor is
                    // quoted rather than emitted as bare (and thus invalid) source.
                    assertIdentifier(relation.table, "relation target table");

                    return `        ${renderPropertyKey(relation.name)}: ${relation.kind === "one" ? "OneRelation" : "ManyRelation"}<"${relation.table}">;`;
                })
                .join("\n");

            return entries ? `    ${table.name}: {\n${entries}\n    };` : `    ${table.name}: {};`;
        })
        .join("\n");

    // DEPENDENCY-FREE BY CONSTRUCTION. This file carries only the shapes derived
    // from the user's schema — `Doc_*`, `Insert_*`, `Id`, the table unions and
    // index maps — and imports nothing. The query-DSL bindings that parameterize
    // `@lunora/server/data-model` over those maps live in `server.ts`, which is
    // the server-only file already.
    //
    // That split is the point: a sibling package (a web app, another Worker)
    // consuming `api.ts` pulls in `dataModel.ts` for `Doc`/`Id`, and used to have
    // to compile `@lunora/server`'s types to do it — dragging a server package
    // into every consumer for a branded string and a few interfaces.
    //
    // Rebased against `schema.ts` on the way out: a `v.from(externalSchema)`
    // column whose recovered type names something from the schema module's own
    // `./lib/…` renders as `import("./lib/x")`, which means
    // `lunora/_generated/lib/x` once inlined here. Applied to the whole rendered
    // file rather than per-column so a future column-rendering path cannot miss
    // it; absolute specifiers are left alone.

    return rebaseRelativeQualifiers(
        `${GENERATED_HEADER}export type TableName = ${tableNames};

/**
 * The tables **this app declared** — every {@link TableName} except those an add-on
 * contributed through \`defineSchema(...).extend(...)\`.
 *
 * An add-on's tables are real tables and stay in \`TableName\` (they are queryable,
 * they appear in \`DataModel\`), but an app enumerating "my tables" should not have to
 * know they exist: an account-deletion sweep, an export, a migration allowlist, or a
 * helper generic over a table union is about the app's own data, and every add-on
 * added or removed would otherwise silently change the correct answer.
 *
 * \`\`\`ts
 * // Doesn't need to mention \`ratelimit_buckets\`, and won't drift when an add-on lands.
 * const EXPORTED: readonly AppTableName[] = ["nodes", "tagColors"];
 * \`\`\`
 */
export type AppTableName = ${appTableNames};

export type Id<TName extends string> = string & { readonly __table: TName };

${documents}

export interface DataModel {
${documentMap}
}

export type Doc<T extends keyof DataModel> = DataModel[T];

/**
 * Per-table index name union. \`never\` for tables without secondary indexes.
 * Used by \`TableReader.withIndex()\` to constrain callers to declared names.
 */
export interface IndexNamesByTable {
${indexNamesByTable}
}

export type IndexName<T extends keyof DataModel> = IndexNamesByTable[T];

/** Per-table search-index name union. \`never\` for tables without searchIndex. */
export interface SearchIndexNamesByTable {
${searchIndexNamesByTable}
}

export type SearchIndexName<T extends keyof DataModel> = SearchIndexNamesByTable[T];

/** Per-table rank-index name union. \`never\` for tables without a rankIndex. */
export interface RankIndexNamesByTable {
${rankIndexNamesByTable}
}

export type RankIndexName<T extends keyof DataModel> = RankIndexNamesByTable[T];

/** Per-table geo-index name union. \`never\` for tables without a geoIndex. */
export interface GeoIndexNamesByTable {
${geoIndexNamesByTable}
}

export type GeoIndexName<T extends keyof DataModel> = GeoIndexNamesByTable[T];

/** Union of declared vector index names. \`never\` when none are declared. */
export type VectorIndexName = ${vectorIndexNames};

${insertInterfaces}

/** Per-table insert shape, accepted by \`ctx.db.<table>.insert(...)\`. */
export interface InsertModel {
${insertMap}
}

export type Insert<T extends keyof DataModel> = InsertModel[T];

/**
 * Phantom relation descriptors. They carry the relation kind and target table
 * as type parameters only — there is no runtime value — so the \`with\` argument
 * and its return type can be inferred from {@link Relations}.
 */
export interface OneRelation<Target extends keyof DataModel> {
    readonly __relationKind: "one";
    readonly __target: Target;
}

export interface ManyRelation<Target extends keyof DataModel> {
    readonly __relationKind: "many";
    readonly __target: Target;
}

/** Per-table relation map keyed by accessor name. \`{}\` for tables with none. */
export interface Relations {
${relationsMap}
}

`,
        SCHEMA_MODULE_PATH,
    );
};

export { emitDataModel, SCHEMA_MODULE_PATH };
