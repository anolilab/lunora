/**
 * Single source of truth for the schema facts both the wrangler validator and
 * binding inference need (`.global()` tables → `DB`, vector indexes → Vectorize
 * bindings). Inference and validation are designed to never disagree; the
 * surest way to guarantee that is to derive these facts from one helper rather
 * than two copies of the same `ts-morph` + `discoverSchema` construction.
 */
import { existsSync } from "node:fs";

import { discoverSchema } from "@lunora/codegen";
import { Project } from "ts-morph";

import join from "./path";

interface SchemaInfo {
    /** Whether the lunora schema declares any `.global()` table. */
    hasGlobalTable: boolean;
    /** Names of vector indexes declared via `.vectorize()` / `defineVectorIndex()`. */
    vectorIndexNames?: ReadonlyArray<string>;
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
        const schema = discoverSchema(project, schemaPath);

        return {
            info: {
                hasGlobalTable: schema.tables.some((table) => table.shardMode === "global"),
                vectorIndexNames: schema.vectorIndexes.map((index) => index.name),
            },
        };
    } catch (error: unknown) {
        return { error: error instanceof Error ? error.message : String(error), info: undefined };
    }
};

export type { DiscoverSchemaInfoResult, SchemaInfo };
export { discoverSchemaInfo };
