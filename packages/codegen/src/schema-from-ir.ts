import type { Schema } from "@lunora/server";

import type { SchemaIR, ValidatorIR } from "./ir";

/**
 * Bridge the static {@link SchemaIR} (lifted from `lunora/schema.ts` by ts-morph
 * via {@link ./discover-schema}) into the runtime `Schema` shape `@lunora/seed`'s
 * introspection reads. Neither the CLI (`lunora seed`) nor the studio's
 * generate-rows endpoint ever executes the user's schema module — they only have
 * the IR — so we synthesize validator-like objects carrying the `kind` + `_meta`
 * surface `introspectSchema`/`generateValue` touch (`column`, `inner`, `members`,
 * `shape`, `tableName`, `value`, `keyValidator`/`valueValidator`).
 *
 * Constraints from `.check()`/`.meta()` are not in the IR, so this path skips
 * them; unions still resolve via `members`, which the IR does carry.
 */

/**
 * The minimal validator surface `@lunora/seed` reads off `_meta` — a structural
 * subset of that package's `ValidatorMeta`. `constraints` (`.check()`/`.meta()`)
 * and `defaultFn` are intentionally absent: neither is recoverable from the
 * static IR, so this path generates without those bounds.
 */
interface SyntheticMeta {
    column?: { defaultValue?: unknown; notNull?: boolean; unique?: boolean };
    inner?: SyntheticValidator;
    keyValidator?: SyntheticValidator;
    members?: SyntheticValidator[];
    shape?: Record<string, SyntheticValidator>;
    tableName?: string;
    value?: unknown;
    valueValidator?: SyntheticValidator;
}

interface SyntheticValidator {
    _meta: SyntheticMeta;
    kind: string;
}

/**
 * Parse a `v.literal(...)` value from the IR's verbatim source text. Handles
 * JSON-native literals (numbers, booleans, double-quoted strings) and
 * single-quoted string literals; anything else (template/computed literals)
 * falls through to the trimmed source text. Literals only feed `copycat.oneOf`
 * over union members, so an imperfect parse still yields a deterministic value.
 */
const parseLiteral = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        const trimmed = text.trim();

        // A single-quoted string literal (`'admin'`) isn't valid JSON; strip the quotes.
        if (trimmed.length >= 2 && (trimmed.startsWith("'") || trimmed.startsWith('"')) && trimmed.at(-1) === trimmed[0]) {
            return trimmed.slice(1, -1);
        }

        return trimmed;
    }
};

const convertValidator = (ir: ValidatorIR): SyntheticValidator => {
    const meta: SyntheticMeta = {};

    if (ir.column !== undefined) {
        meta.column = {
            // A non-undefined `defaultValue` is the sentinel `hasServerDefault`
            // reads to skip the column (the server fills `.default()`/`.$defaultFn()`).
            // eslint-disable-next-line unicorn/no-null -- null is a deliberate non-undefined sentinel here
            defaultValue: ir.column.hasDefault === true ? null : undefined,
            notNull: ir.column.notNull,
            unique: ir.column.unique,
        };
    }

    if (ir.inner !== undefined) {
        meta.inner = convertValidator(ir.inner);
    }

    if (ir.members !== undefined) {
        meta.members = ir.members.map((member) => convertValidator(member));
    }

    if (ir.shape !== undefined) {
        meta.shape = Object.fromEntries(Object.entries(ir.shape).map(([field, child]) => [field, convertValidator(child)]));
    }

    if (ir.tableName !== undefined) {
        meta.tableName = ir.tableName;
    }

    if (ir.literalValue !== undefined) {
        meta.value = parseLiteral(ir.literalValue);
    }

    if (ir.keyType !== undefined) {
        meta.keyValidator = convertValidator(ir.keyType);
    }

    if (ir.valueType !== undefined) {
        meta.valueValidator = convertValidator(ir.valueType);
    }

    return { _meta: meta, kind: ir.kind };
};

/**
 * Convert a {@link SchemaIR} into a synthetic runtime {@link Schema} carrying just
 * the `tables[name].shape` surface `@lunora/seed` introspects. System columns
 * (`_id`, `_creationTime`) are absent from the IR shape, exactly as the seed
 * engine expects (it assigns `_id` itself).
 */
const schemaFromIr = (ir: SchemaIR): Schema => {
    const tables = Object.fromEntries(
        ir.tables.map((table) => [
            table.name,
            { shape: Object.fromEntries(Object.entries(table.shape).map(([field, validator]) => [field, convertValidator(validator)])) },
        ]),
    );

    // The synthetic tables carry only the `shape` surface `@lunora/seed`'s
    // introspection reads — never the full `TableDefinition` (indexes,
    // relationMap, …) — so the cast through `unknown` is load-bearing.
    return { tables } as unknown as Schema;
};

// eslint-disable-next-line import/prefer-default-export -- named export: import sites stay uniform, per the repo's no-default-mixing convention
export { schemaFromIr };
