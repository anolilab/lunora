/**
 * Single source of truth for the schema facts both the wrangler validator and
 * binding inference need (`.global()` tables → `DB`, vector indexes → Vectorize
 * bindings). Inference and validation are designed to never disagree; the
 * surest way to guarantee that is to derive these facts from one helper rather
 * than two copies of the same `ts-morph` + `discoverSchema` construction.
 */
import { existsSync } from "node:fs";

import { discoverSchema, isD1GlobalTable, isHyperdriveGlobalTable } from "@lunora/codegen";
import { Project } from "ts-morph";

import join from "./path";

/** One filterable Vectorize metadata property a schema declares. */
interface VectorMetadataDeclaration {
    /** The vector index the property belongs to. */
    index: string;

    /**
     * The validator kind behind the column, or `undefined` when the column
     * isn't in the owning table's shape. Callers map it to the Vectorize
     * metadata type; a kind that can't be filtered on is reported, not indexed.
     */
    kind: string | undefined;
    /** Column mirrored into vector metadata. */
    property: string;
}

interface SchemaInfo {
    /**
     * Whether the schema declares a **D1-backed** `.global()` table — the only
     * flavour that needs the `DB` binding and the app's `.global({ d1 })` chain.
     * A `.global({ backend: "hyperdrive" })` table needs neither, and counting it
     * here demanded a D1 database of a project that has none.
     */
    hasD1GlobalTable: boolean;
    /** Whether the schema declares a `.global({ backend: "hyperdrive" })` table — needs the app's `.hyperdriveGlobal(...)` chain instead. Required, not optional: the only producer always knows the answer, and `?` made every consumer read a two-valued fact as three-valued. */
    hasHyperdriveGlobalTable: boolean;
    /** Names of vector indexes declared via `.vectorize()` / `defineVectorIndex()`. */
    vectorIndexNames?: ReadonlyArray<string>;

    /**
     * Metadata properties declared filterable on a vector index. Cloudflare
     * needs an explicit metadata index per property before a `filter` can match
     * anything, so deploy provisions these and doctor reports them.
     */
    vectorMetadata?: ReadonlyArray<VectorMetadataDeclaration>;
}

interface DiscoverSchemaInfoResult {
    /** Parse error message, when the schema exists but could not be analyzed. */
    error?: string;
    /** Schema facts, or `undefined` when no `schema.ts` exists or parsing failed. */
    info: SchemaInfo | undefined;
}

/**
 * Discover {@link SchemaInfo} for a project. Returns `{ info: undefined }` when
 * the project declares no `schema.ts` (not an error), or `{ info: undefined,
 * error }` when a present schema could not be parsed — callers decide whether a
 * parse failure is a warning (validator) or simply ignorable (inference).
 */
const discoverSchemaInfo = (projectRoot: string, schemaDirectory: string): DiscoverSchemaInfoResult => {
    const schemaPath = join(projectRoot, schemaDirectory, "schema.ts");

    if (!existsSync(schemaPath)) {
        return { info: undefined };
    }

    try {
        const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
        // Pass `projectRoot` so a package-defined `.extend(...)` (resolved by
        // importing the dep) is seen here too — keeping binding inference + the
        // wrangler validator consistent with what codegen emits.
        const schema = discoverSchema(project, schemaPath, projectRoot);

        const shapeOf = (tableName: string): Record<string, { kind?: string }> => schema.tables.find((table) => table.name === tableName)?.shape ?? {};

        return {
            info: {
                hasD1GlobalTable: schema.tables.some((table) => isD1GlobalTable(table)),
                hasHyperdriveGlobalTable: schema.tables.some((table) => isHyperdriveGlobalTable(table)),
                vectorIndexNames: schema.vectorIndexes.map((index) => index.name),
                vectorMetadata: schema.vectorIndexes.flatMap((index) =>
                    (index.metadata ?? []).map((property) => {
                        return { index: index.name, kind: shapeOf(index.table)[property]?.kind, property };
                    }),
                ),
            },
        };
    } catch (error: unknown) {
        return { error: error instanceof Error ? error.message : String(error), info: undefined };
    }
};

export type { DiscoverSchemaInfoResult, SchemaInfo, VectorMetadataDeclaration };
export { discoverSchemaInfo };
