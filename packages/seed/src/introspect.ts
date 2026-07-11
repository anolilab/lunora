import type { Schema } from "@lunora/server";
import type { Validator } from "@lunora/values";
import { optionalInner } from "@lunora/values";

/**
 * Schema introspection for seeding. Reads the runtime `Schema` produced by
 * `defineSchema` into a flat, generator-friendly description of every table and
 * column, and computes a foreign-key-respecting insert order.
 *
 * The validator internals (`kind`, `_meta`) are the same surface `@lunora/codegen`
 * reads to build its IR. We touch `_meta` directly here — it is the documented
 * reflection bag — but unwrap `v.optional(...)` through the exported
 * {@link optionalInner} accessor rather than reaching in for `inner`.
 */

/** The internal reflection bag every validator carries (see `@lunora/values`). */
interface ValidatorMeta {
    column?: { defaultFn?: unknown; defaultValue?: unknown; notNull?: boolean; unique?: boolean };
    constraints?: Record<string, unknown>;
    inner?: Validator;
    keyValidator?: Validator;
    members?: ReadonlyArray<Validator>;
    shape?: Record<string, Validator>;
    tableName?: string;
    value?: unknown;
    valueValidator?: Validator;
}

/** Read a validator's internal `_meta` bag. */
const metaOf = (validator: Validator): ValidatorMeta => (validator as { _meta?: ValidatorMeta })._meta ?? {};

/** Unwrap a leading `v.optional(...)`, returning the inner validator (or the validator itself). */
const unwrapOptional = (validator: Validator): Validator => optionalInner(validator) ?? validator;

/** A single seedable column. */
interface FieldSpec {
    /** The target table when this column is (or wraps) `v.id("table")`. */
    fkTable?: string;
    /** True when the column carries `.default()` / `.$defaultFn()` — the server fills it, so seeding skips it. */
    hasServerDefault: boolean;
    /** The validator `kind` after unwrapping `v.optional`. */
    kind: string;
    name: string;
    /** True when the column is `.nullable()`. */
    nullable: boolean;
    /** True when the column is wrapped in `v.optional(...)`. */
    optional: boolean;
    /** The validator to generate a value from (the inner one when optional). */
    validator: Validator;
}

/** A table reduced to its seedable columns. */
interface TableSpec {
    fields: ReadonlyArray<FieldSpec>;
    name: string;
}

/** True when a column (or the column it wraps via optional) has a server-applied default. */
const hasServerDefault = (validator: Validator): boolean => {
    const { column } = metaOf(validator);

    if (column?.defaultValue !== undefined || column?.defaultFn !== undefined) {
        return true;
    }

    const inner = optionalInner(validator);

    return inner === undefined ? false : hasServerDefault(inner);
};

/** Build a {@link FieldSpec} for one column of a table's shape. */
const describeField = (name: string, validator: Validator): FieldSpec => {
    const inner = unwrapOptional(validator);
    const meta = metaOf(inner);

    return {
        fkTable: inner.kind === "id" ? meta.tableName : undefined,
        hasServerDefault: hasServerDefault(validator),
        kind: inner.kind,
        name,
        // `notNull` is tri-state: `true` (default / `.notNull()`), `false`
        // (`.nullable()`), or `undefined` (no column metadata). Only an explicit
        // `false` means the user opted the column into SQL `NULL` — which is what
        // `fkFallback` keys off to emit `null` for an unresolved nullable FK. This
        // mirrors codegen's own `isNullable` (`column?.notNull === false`).
        nullable: meta.column?.notNull === false,
        optional: validator.kind === "optional",
        validator: inner,
    };
};

/** Reduce a `defineSchema` result to a {@link TableSpec} per table. */
const introspectSchema = (schema: Schema): ReadonlyArray<TableSpec> => {
    const { tables } = schema;

    return Object.entries(tables).map(([name, table]) => {
        return {
            fields: Object.entries(table.shape).map(([fieldName, validator]) => describeField(fieldName, validator)),
            name,
        };
    });
};

/**
 * Order `selected` tables so a table's foreign-key parents are inserted first.
 * Edges are the `v.id("parent")` columns whose parent is also selected;
 * self-references and edges into unselected tables are ignored for ordering
 * (the plan resolves those FKs against whatever rows exist, or null). Cycles
 * across tables are broken by emitting remaining tables in declaration order.
 */
const orderTables = (specs: ReadonlyArray<TableSpec>, selected: ReadonlySet<string>): ReadonlyArray<string> => {
    const byName = new Map(specs.map((spec) => [spec.name, spec]));
    const parentsOf = (name: string): Set<string> => {
        const spec = byName.get(name);

        if (spec === undefined) {
            return new Set();
        }

        const parents = new Set<string>();

        for (const field of spec.fields) {
            if (field.fkTable !== undefined && field.fkTable !== name && selected.has(field.fkTable)) {
                parents.add(field.fkTable);
            }
        }

        return parents;
    };

    const ordered: string[] = [];
    const placed = new Set<string>();
    const pending = [...selected].filter((name) => byName.has(name));

    // Repeatedly emit any pending table whose parents are all placed. When a full
    // pass places nothing (a cycle), emit the first remaining table to break it.
    while (pending.length > 0) {
        const readyIndex = pending.findIndex((name) => [...parentsOf(name)].every((parent) => placed.has(parent)));
        const index = readyIndex === -1 ? 0 : readyIndex;
        const [name] = pending.splice(index, 1);

        if (name === undefined) {
            break;
        }

        ordered.push(name);
        placed.add(name);
    }

    return ordered;
};

/**
 * Expand `roots` to include every transitive foreign-key parent table that also
 * exists in `specs`. Self-references add no new table, and edges into tables not
 * present in `specs` are ignored. Used so seeding a child (`only`/`--table`)
 * automatically seeds the parents its `v.id(...)` columns point at.
 *
 * `stopAt` names tables the traversal must not descend through — a parent already
 * covered by `existingIds` (and not requested) won't be seeded, so pulling in its
 * own parents would seed unrelated grandparent tables. Such a table may still be
 * added as a parent of a requested table, but its FK edges are not followed.
 */
const fkParentClosure = (specs: ReadonlyArray<TableSpec>, roots: Iterable<string>, stopAt: ReadonlySet<string> = new Set()): Set<string> => {
    const byName = new Map(specs.map((spec) => [spec.name, spec]));
    const result = new Set(roots);
    const stack = [...result];

    while (stack.length > 0) {
        const name = stack.pop();

        if (name === undefined) {
            break;
        }

        const spec = byName.get(name);

        if (spec === undefined) {
            continue;
        }

        // A covered parent is a leaf for closure purposes: it is added to the
        // result (as some requested table's parent) but its own parents are not.
        if (stopAt.has(name)) {
            continue;
        }

        for (const field of spec.fields) {
            if (field.fkTable !== undefined && field.fkTable !== name && byName.has(field.fkTable) && !result.has(field.fkTable)) {
                result.add(field.fkTable);
                stack.push(field.fkTable);
            }
        }
    }

    return result;
};

export { describeField, fkParentClosure, introspectSchema, metaOf, orderTables, unwrapOptional };
export type { FieldSpec, TableSpec, ValidatorMeta };
