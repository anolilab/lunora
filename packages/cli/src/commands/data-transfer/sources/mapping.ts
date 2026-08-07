/**
 * `lunora/import-supabase.json` and `lunora/import-firebase.json`: the
 * operator-confirmed statement of how a foreign dump maps onto Lunora tables.
 *
 * Both sources share one shape because they answer the same three questions —
 * which file feeds which table, which column is the id, and which columns need a
 * declared reshape. Only the reshape vocabulary differs, and that is enforced by
 * {@link isReshapeKind} rather than by two parsers.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { LunoraError } from "@lunora/errors";

import type { Logger } from "../../../util/logger";
import { assertMappingObject, assertOptionalString, assertOptionalStringArray, isPlainObject } from "../mapping-shapes";
import type { ReshapeKind } from "./reshape";
import { isReshapeKind, RESHAPE_KINDS } from "./reshape";

/** How one source file becomes one Lunora table. */
interface TableMapping {
    /** Source file, relative to the import directory. Defaults to `<table>.csv` / `<table>.json`. */
    file?: string;
    /** Source column preserved as `_id`. Defaults to `id` (Supabase) / the document name (Firebase). */
    idColumn?: string;
    /** Columns holding storage paths, rewritten to R2 keys when `--with-storage` runs. */
    storageColumns?: string[];
    /** Column → declared reshape. A column absent here is copied through untouched. */
    types?: Record<string, ReshapeKind>;
}

/** Shape of `lunora/import-<source>.json`. */
interface ImportSourceMapping {
    /**
     * Auth dump → better-auth `user`/`account` rows. `file` is the users dump
     * (`auth.users.csv` / a Firebase `auth:export` JSON); `identitiesFile` is
     * Supabase's `auth.identities` dump, which carries the linked providers.
     */
    auth?: { file?: string; identitiesFile?: string };
    /** Optional R2 key prefix for migrated storage objects. */
    keyPrefix?: string;
    tables?: Record<string, TableMapping>;
}

const parseTableMapping = (rawEntry: unknown, where: string): TableMapping => {
    const raw = assertMappingObject(rawEntry, where);
    const file = assertOptionalString(raw, "file", where);
    const idColumn = assertOptionalString(raw, "idColumn", where);
    const storageColumns = assertOptionalStringArray(raw, "storageColumns", where);
    const { types } = raw;

    if (types !== undefined) {
        if (!isPlainObject(types)) {
            throw new LunoraError("INTERNAL", `${where}.types must be an object of column → reshape`);
        }

        for (const [column, kind] of Object.entries(types)) {
            if (!isReshapeKind(kind)) {
                throw new LunoraError(
                    "INTERNAL",
                    `${where}.types.${column}: unknown reshape ${JSON.stringify(kind)} — expected one of ${RESHAPE_KINDS.join(", ")}`,
                );
            }
        }
    }

    return { file, idColumn, storageColumns, types: types as Record<string, ReshapeKind> | undefined };
};

/** Validate the optional `auth` block. */
const assertAuthMapping = (auth: unknown, mappingPath: string): void => {
    if (auth === undefined) {
        return;
    }

    if (!isPlainObject(auth)) {
        throw new LunoraError("INTERNAL", `${mappingPath}: \`auth\` must be an object`);
    }

    for (const key of ["file", "identitiesFile"]) {
        assertOptionalString(auth, key, `${mappingPath}: auth`);
    }
};

/** Validate the optional `tables` block, one entry at a time. */
const parseTables = (tables: unknown, mappingPath: string): Record<string, TableMapping> | undefined => {
    if (tables === undefined) {
        return undefined;
    }

    if (!isPlainObject(tables)) {
        throw new LunoraError("INTERNAL", `${mappingPath}: \`tables\` must be an object of table → mapping`);
    }

    return Object.fromEntries(Object.entries(tables).map(([table, mapping]) => [table, parseTableMapping(mapping, `${mappingPath}: tables.${table}`)]));
};

/**
 * Narrow a parsed mapping file, or throw naming the offending key.
 *
 * A mapping that fails to parse must NOT degrade to "no mapping": it is the only
 * statement of which columns need reshaping, so dropping it on a parse error
 * turns a declared conversion into a silent pass-through — the exact silent data
 * corruption the reshape rule exists to prevent. Only a *missing* file is
 * optional.
 */
const parseImportSourceMapping = (rawMapping: unknown, mappingPath: string): ImportSourceMapping => {
    const raw = assertMappingObject(rawMapping, mappingPath);
    const keyPrefix = assertOptionalString(raw, "keyPrefix", mappingPath);
    const { auth, tables } = raw;

    assertAuthMapping(auth, mappingPath);

    return { auth: auth as ImportSourceMapping["auth"], keyPrefix, tables: parseTables(tables, mappingPath) };
};

/** Where a source's mapping file lives inside a project. */
const mappingFileFor = (source: "firebase" | "supabase"): string => join("lunora", `import-${source}.json`);

/**
 * Read `lunora/import-<source>.json`. Returns `undefined` only when the file
 * does not exist; an unreadable or invalid mapping throws.
 */
const readImportSourceMapping = async (cwd: string, source: "firebase" | "supabase", logger: Logger): Promise<ImportSourceMapping | undefined> => {
    const relative = mappingFileFor(source);
    const mappingPath = join(cwd, relative);
    let content: string;

    try {
        content = await readFile(mappingPath, "utf8");
    } catch (error: unknown) {
        if ((error as { code?: string }).code === "ENOENT") {
            logger.info(`no ${relative} found — every column is copied through untouched (run with --scan to generate one)`);

            return undefined;
        }

        throw error;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(content);
    } catch (error: unknown) {
        throw new LunoraError("INTERNAL", `${mappingPath}: invalid JSON — ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    return parseImportSourceMapping(parsed, mappingPath);
};

export type { ImportSourceMapping, TableMapping };
export { mappingFileFor, parseImportSourceMapping, readImportSourceMapping };
