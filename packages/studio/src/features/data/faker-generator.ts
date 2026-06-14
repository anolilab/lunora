import { faker } from "@faker-js/faker";

import type { ColumnMeta } from "../../lib/admin";

/**
 * The maximum number of dummy rows the generator will produce in a single
 * call. Bounded to keep inserts fast and the UI responsive; the operator
 * can call again for more.
 */
const MAX_GENERATE_ROWS = 200;

/**
 * The maximum number of existing row ids sampled when a `v.id("table")`
 * column needs a real FK reference. Sampling more than this is unnecessary —
 * we only need a pool to pick from, not a full table scan.
 */
const MAX_FK_SAMPLE = 50;

/**
 * Generate a plausible string value based on the column name using heuristics:
 * email → internet.email, url/link → internet.url, name → person.fullName, etc.
 * Falls back to `faker.lorem.word()` for unrecognised column names.
 */
const generateStringValue = (columnName: string): string => {
    const lower = columnName.toLowerCase();

    if (lower.includes("email")) {
        return faker.internet.email();
    }

    if (lower.includes("name")) {
        return faker.person.fullName();
    }

    if (lower.includes("title")) {
        return faker.lorem.sentence({ max: 5, min: 2 });
    }

    if (lower.includes("url") || lower.includes("link")) {
        return faker.internet.url();
    }

    if (lower.includes("phone")) {
        return faker.phone.number();
    }

    if (lower.includes("description") || lower.includes("bio") || lower.includes("text") || lower.includes("content")) {
        return faker.lorem.paragraph();
    }

    if (lower.includes("slug") || lower.includes("key") || lower.includes("code")) {
        return faker.lorem.slug();
    }

    if (lower.includes("color") || lower.includes("colour")) {
        return faker.color.rgb();
    }

    if (lower.includes("city")) {
        return faker.location.city();
    }

    if (lower.includes("country")) {
        return faker.location.country();
    }

    if (lower.includes("address")) {
        return faker.location.streetAddress();
    }

    return faker.lorem.word();
};

/**
 * Generate a plausible faker value for a single column based on its validator
 * IR kind (`ColumnMeta.type`).
 *
 * The mapping is intentionally heuristic — the validator kind is the only
 * schema information available client-side:
 *
 * - `string`  → heuristic by column name, fallback `faker.lorem.word()`
 * - `number`  → `faker.number.int({ min: 0, max: 1000 })`
 * - `float`   → `faker.number.float({ min: 0, max: 1000 })`
 * - `boolean` → `faker.datatype.boolean()`
 * - `id`      → random UUID placeholder (or FK pool pick when `ref` is set)
 * - `array`   → empty array `[]`
 * - `object`  → empty object `{}`
 * - `bytes`   → base64 string of 8 alphanumeric bytes
 * - `null`    → `null`
 * - anything else (e.g. `union`, `literal`, `any`) → `undefined`
 *
 * Columns declared `optional` may return `undefined` ~30% of the time so the
 * generated data exercises optional branches.
 *
 * FK columns (`ref` is set) must be handled by the caller: pass a non-empty
 * `fkPool` and this function picks uniformly from it. If the pool is empty the
 * column is skipped (returns `undefined`) and the caller surfaces a note.
 */
const generateValue = (column: ColumnMeta, fkPool: ReadonlyArray<string>): unknown => {
    // Optional columns are sometimes omitted (~30 %) to exercise optional branches.
    if (column.optional && column.pk !== true && faker.datatype.boolean({ probability: 0.3 })) {
        return undefined;
    }

    // FK column: pick a random id from the pool. If the pool is empty, skip.
    if (column.ref !== undefined && column.type === "id") {
        if (fkPool.length === 0) {
            return undefined;
        }

        return fkPool[faker.number.int({ max: fkPool.length - 1, min: 0 })];
    }

    switch (column.type) {
        case "array": {
            return [];
        }

        case "boolean": {
            return faker.datatype.boolean();
        }

        case "bytes": {
            // Base64 of 8 alphanumeric characters.
            return Buffer.from(faker.string.alphanumeric(8)).toString("base64");
        }

        case "float": {
            return faker.number.float({ max: 1000, min: 0 });
        }

        case "id": {
            // No ref — produce a UUID-like placeholder string.
            return faker.string.uuid();
        }

        case "null": {
            // eslint-disable-next-line unicorn/no-null -- null is the correct domain value for a `v.null()` column
            return null;
        }

        case "number": {
            return faker.number.int({ max: 1000, min: 0 });
        }

        case "object": {
            return {};
        }

        case "string": {
            return generateStringValue(column.name);
        }

        default: {
            // union, literal, any, or any future type → skip
            return undefined;
        }
    }
};

/** The result of generating dummy rows for one table. */
interface GenerateResult {
    /** The generated row documents, ready to insert via `writeRow`. */
    rows: Record<string, unknown>[];
    /** Columns skipped because their FK pool was empty (no rows in target table). */
    skippedFkColumns: string[];
}

/**
 * Collect the names of FK columns whose pool is empty so they can be surfaced
 * in the UI before generation starts.
 */
const collectSkippedFkColumns = (editableColumns: ReadonlyArray<ColumnMeta>, fkPools: Readonly<Record<string, ReadonlyArray<string>>>): string[] => {
    const skipped: string[] = [];

    for (const column of editableColumns) {
        if (column.ref !== undefined && column.type === "id") {
            const pool = fkPools[column.ref] ?? [];

            if (pool.length === 0) {
                skipped.push(column.name);
            }
        }
    }

    return skipped;
};

/**
 * Generate `count` dummy rows for the given table columns.
 * @param columns The table's column metadata (from `describeTable`).
 * @param count How many rows to produce (clamped to {@link MAX_GENERATE_ROWS}).
 * @param fkPools Map of `column.ref → array of existing row ids` for FK columns.
 * Caller is responsible for fetching these; pass `{}` to skip FK columns.
 */
const generateRows = (columns: ReadonlyArray<ColumnMeta>, count: number, fkPools: Readonly<Record<string, ReadonlyArray<string>>>): GenerateResult => {
    const clamped = Math.min(Math.max(1, count), MAX_GENERATE_ROWS);

    // Editable columns only — exclude pk (_id) since the server auto-assigns it.
    const editableColumns = columns.filter((column) => column.pk !== true);
    const skippedFkColumns = collectSkippedFkColumns(editableColumns, fkPools);
    const rows: Record<string, unknown>[] = [];

    for (let index = 0; index < clamped; index += 1) {
        const row: Record<string, unknown> = {};

        for (const column of editableColumns) {
            const pool = column.ref === undefined ? [] : (fkPools[column.ref] ?? []);
            const value = generateValue(column, pool);

            if (value !== undefined) {
                row[column.name] = value;
            }
        }

        rows.push(row);
    }

    return { rows, skippedFkColumns };
};

export { generateRows, generateValue, MAX_FK_SAMPLE, MAX_GENERATE_ROWS };
export type { GenerateResult };
