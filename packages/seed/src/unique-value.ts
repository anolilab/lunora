import { LunoraError } from "@lunora/errors";

import { copycat } from "./copycat";
import type { Constraints } from "./generate-value";
import { BIGINT_RANGE, constraintsOf, FALLBACK_EMAIL_DOMAIN, isTimestampField, NUMBER_RANGE, resolveRange } from "./generate-value";
import type { FieldSpec } from "./introspect";
import { metaOf } from "./introspect";

/**
 * How a `.unique()` column turns a row's ABSOLUTE index into a value no other
 * row will produce.
 *
 * Every arm is a function of the index alone, so uniqueness holds by
 * construction rather than by luck — including across the several calls
 * `indexOffset` exists to support. {@link UniqueDeal.capacity} is how many
 * distinct values the arm can produce; the planner refuses up front when a
 * batch asks for more, so an impossible schema fails with the column named
 * instead of as a raw UNIQUE-constraint error from the database.
 */
interface UniqueDeal {
    /** How many distinct values this column can yield. `Infinity` when unbounded. */
    capacity: number;

    /**
     * The value for one row.
     * @param index the row's absolute index, always below {@link UniqueDeal.capacity}.
     * @param generate produces the value the normal generator would have emitted; called only by the arms that build on it.
     */
    valueAt: (index: number, generate: () => unknown) => unknown;
}

/** Options {@link planUniqueDeal} needs beyond the column itself. */
interface UniqueDealOptions {
    /** Wall-clock reference for temporal columns, matching the rest of the plan. */
    now: number;
    table: string;
}

/** Slots a float column's range is divided into. Fixed (not derived from the row count) so two batches of the same table never land on the same value. */
const FLOAT_SLOTS = 1_000_000;

/** Spacing between two unique temporal values. A minute keeps a seeded month readable while still fitting 259,200 distinct rows in the generator's window. */
const TIMESTAMP_STEP_MS = 60_000;

/** Bytes columns are 8 bytes wide; the first four carry the index, so the capacity is the range of a uint32. */
const BYTES_CAPACITY = 2 ** 32;

/**
 * Deterministically shuffle a finite domain so dealt values aren't simply the
 * declaration order. Hashed per (table, column); variance across seeds comes
 * from the global hash salt, like every other generated value.
 */
const shuffleDomain = (domain: ReadonlyArray<unknown>, table: string, column: string): ReadonlyArray<unknown> => {
    const out = [...domain];

    for (let index = out.length - 1; index > 0; index -= 1) {
        const swap = copycat.int([table, column, "unique-deal", index], { max: index, min: 0 });
        const held = out[index];

        out[index] = out[swap];
        out[swap] = held;
    }

    return out;
};

/**
 * Make a generated string row-unique while keeping the shape the generator just
 * produced: an address keeps its form via a plus-tag (`local+3@domain`),
 * anything else takes an index suffix.
 *
 * Room for the tag is reserved BEFORE truncating, so a `maxLength` the
 * generator honoured is not then broken by the tag — appending first and
 * truncating after would either overflow the column or cut the tag off and
 * reintroduce the collision.
 */
const uniquifyString = (value: string, index: number, constraints: Constraints): string => {
    const { maxLength } = constraints;
    const tag = String(index);
    const at = value.indexOf("@");

    if (at > 0) {
        const local = value.slice(0, at);
        const domain = value.slice(at);
        const room = maxLength === undefined ? local.length : maxLength - domain.length - tag.length - 1;

        // A generated address whose own domain fills the column leaves no room
        // for a plus-tag: clamping to zero here would emit `+7@a-very-long.example`
        // OVER `maxLength`, which is the overflow this reservation exists to
        // prevent. Fall through instead — an `email` column rebuilds the address
        // around the fixed fallback domain {@link stringCapacity} budgeted for,
        // and anything else takes the plain index suffix.
        if (room >= 0) {
            return `${local.slice(0, room)}+${tag}${domain}`;
        }
    }

    // The column declares `format: "email"` but the field-name heuristics didn't
    // produce an address (a column called `contact` or `login` generates a bare
    // word). Tagging that word would leave the value unique but invalid, so
    // build an address around the tag instead.
    if (constraints.format === "email") {
        const room = maxLength === undefined ? value.length : Math.max(0, maxLength - FALLBACK_EMAIL_DOMAIN.length - tag.length);

        return `${value.slice(0, room)}${tag}${FALLBACK_EMAIL_DOMAIN}`;
    }

    const suffix = `-${tag}`;
    const room = maxLength === undefined ? value.length : Math.max(0, maxLength - suffix.length);

    return `${value.slice(0, room)}${suffix}`;
};

/** A deal over a finite list of values, drawn without replacement in a fixed shuffled order. */
const domainDeal = (domain: ReadonlyArray<unknown>, table: string, column: string): UniqueDeal => {
    const order = shuffleDomain(domain, table, column);

    return { capacity: order.length, valueAt: (index) => order[index % order.length] };
};

/**
 * A deal over a numeric range. Integer bounds are walked one step at a time;
 * fractional bounds (a float column) are divided into {@link FLOAT_SLOTS}
 * evenly-spaced values, since a real interval cannot be enumerated.
 */
const rangeDeal = (min: number, max: number): UniqueDeal => {
    if (Number.isInteger(min) && Number.isInteger(max)) {
        const capacity = max - min + 1;

        return { capacity, valueAt: (index) => min + (index % capacity) };
    }

    return { capacity: FLOAT_SLOTS, valueAt: (index) => min + ((index % FLOAT_SLOTS) * (max - min)) / FLOAT_SLOTS };
};

/**
 * A deal over epoch-ms, stepping back from `now` one {@link TIMESTAMP_STEP_MS}
 * per row. Unbounded: the first `TIMESTAMP_WINDOW_MS` (`./generate-value`) worth of rows land
 * inside the same window the generator uses, and a batch large enough to run
 * past it simply keeps walking backwards rather than wrapping onto a value an
 * earlier row already took.
 */
const temporalDeal = (now: number): UniqueDeal => {
    return { capacity: Number.POSITIVE_INFINITY, valueAt: (index) => now - index * TIMESTAMP_STEP_MS };
};

/**
 * A deal for a numeric column that declares no bounds. The index IS the value:
 * collision-free however many rows are asked for, and a plain ascending integer
 * is what a unique unconstrained number column looks like anyway. A column that
 * DOES declare bounds goes through {@link rangeDeal} instead, where the declared
 * range is a real capacity limit.
 */
const countingDeal: UniqueDeal = { capacity: Number.POSITIVE_INFINITY, valueAt: (index) => index };

/**
 * The deal for a column whose value is built from the per-cell hash (a uuid, or
 * a composite of them): already distinct per row, so the generator's own value
 * stands and there is no capacity to refuse past.
 */
const anonymousDeal: UniqueDeal = { capacity: Number.POSITIVE_INFINITY, valueAt: (_index, generate) => generate() };

/**
 * Pick the numeric deal for a column: the declared range when it has one (the
 * range is then a hard capacity the planner must refuse past), otherwise an
 * ascending count.
 *
 * A partially-declared range is completed by {@link resolveRange} — the very
 * interval the generator would have drawn from — so the two paths cannot drift.
 * Completing it here with the raw default instead reported a capacity of ZERO
 * for `v.bigint().max(-1).unique()`, refusing at plan time a column with
 * infinitely many values below its bound.
 */
const boundedNumeric = (constraints: Constraints, defaults: { max: number; min: number }, column: string): UniqueDeal => {
    if (constraints.maximum === undefined && constraints.minimum === undefined) {
        return countingDeal;
    }

    const { max, min } = resolveRange(constraints, defaults, column);

    return rangeDeal(min, max);
};

/** Refuse a column whose value shape the seeder cannot make unique without violating it. */
const refuse = (table: string, column: string, why: string): never => {
    throw new LunoraError(
        "INTERNAL",
        `@lunora/seed: cannot generate unique values for "${table}"."${column}" — ${why}. ` +
            `Supply them via \`overrides\` (\`{ ${table}: { ${column}: … } }\`) or drop \`.unique()\` from the column.`,
    );
};

/**
 * How many distinct values a string column can hold once every value has to
 * carry an index tag. A narrow column runs out long before the alphabet does:
 * `maxLength` of 1 leaves no room for even `-0`.
 *
 * The overhead an `email` column pays is the whole {@link FALLBACK_EMAIL_DOMAIN},
 * not the one-character separator: {@link uniquifyString} rebuilds the address
 * around that domain whenever the generated one leaves no room for a plus-tag,
 * so it is the fixed cost the tag has to fit around. Budgeting the cheaper
 * suffix form is what let `v.string().email().max(10).unique()` report a
 * billion possible values and then seed `0@example.com` — thirteen characters
 * into a ten-character column, rejected by the column's own validator on
 * insert, which is exactly the outcome the capacity check exists to pre-empt.
 *
 * With this budget the largest index the planner admits is `10 ** (maxLength -
 * overhead) - 1`, whose tag is at most `maxLength - overhead` characters — so
 * `tag + overhead` always fits.
 */
const stringCapacity = ({ format, maxLength }: Constraints): number => {
    if (maxLength === undefined) {
        return Number.POSITIVE_INFINITY;
    }

    const overhead = format === "email" ? FALLBACK_EMAIL_DOMAIN.length : "-".length;

    return maxLength <= overhead ? 0 : 10 ** (maxLength - overhead);
};

/**
 * The deal for a string-valued column. This is the one shape whose value still
 * comes from the normal generator — the field-name heuristics are worth keeping
 * — so the tag is applied on top of what the generator produced.
 *
 * A column whose declared shape the tag would break is refused here instead of
 * being seeded with a value its own validator rejects on insert.
 */
const stringDeal = (constraints: Constraints, table: string, column: string): UniqueDeal => {
    if (constraints.pattern !== undefined) {
        refuse(table, column, "the column is pattern-constrained, and an index-tagged value would no longer match it");
    }

    // `format: "email"` survives — the tag goes in the address's local part, and
    // a generator that produced no address at all gets one built around the tag.
    // Any other format (uri, uuid, date-time, …) would be invalidated by it.
    if (constraints.format !== undefined && constraints.format !== "email") {
        refuse(table, column, `the column declares format "${constraints.format}", which an index-tagged value would no longer satisfy`);
    }

    return {
        capacity: stringCapacity(constraints),
        valueAt: (index, generate) => uniquifyString(String(generate()), index, constraints),
    };
};

/**
 * The deal a `.unique()` FOREIGN KEY takes: the parent pool drawn without
 * replacement, in a fixed shuffled order.
 *
 * A foreign key's value comes from the plan layer rather than the generator,
 * but it comes from a finite domain like any other — so it is dealt like one.
 * The uniform draw the ordinary path uses (`copycat.oneOf`) picks WITH
 * replacement, which is exactly the collision `.unique()` promises not to make:
 * `v.id("users").unique()`, the natural way to spell a 1:1 relation, produced 7
 * distinct parents across 10 rows. The pool's size is a real capacity, so a
 * batch larger than the parent table is refused at plan time with the column
 * named, the same as a boolean or a three-value enum.
 */
const planUniqueFkDeal = (pool: ReadonlyArray<string>, table: string, column: string): UniqueDeal => domainDeal(pool, table, column);

/**
 * Decide how one `.unique()` column deals its values.
 *
 * A string column is the only shape whose value still comes from the normal
 * generator (the field-name heuristics are worth keeping); every other kind is
 * derived from the index directly. Kinds with no index-derivable form —
 * pattern- or format-constrained strings — are refused here rather than seeded
 * with a value the column's own validator would reject on insert.
 */
const planUniqueDeal = (field: FieldSpec, options: UniqueDealOptions): UniqueDeal => {
    const { now, table } = options;
    const constraints = constraintsOf(field.validator);
    const enumValues = constraints.enum;

    if (Array.isArray(enumValues) && enumValues.length > 0) {
        return domainDeal(enumValues, table, field.name);
    }

    switch (field.kind) {
        // `any` produces a bare word like an unmatched string does, so it needs
        // the same tagging; it simply never carries string constraints.
        case "any":
        case "string": {
            return stringDeal(constraints, table, field.name);
        }

        case "bigint": {
            return boundedNumeric(constraints, BIGINT_RANGE, field.name);
        }

        case "boolean": {
            return domainDeal([false, true], table, field.name);
        }

        case "bytes": {
            // Mirrors the generator's 8-byte plain-number array: the first four
            // bytes carry the index, the rest stay hashed so the value still
            // looks like data rather than a counter.
            return {
                capacity: BYTES_CAPACITY,
                valueAt: (index) => [
                    Math.floor(index / 16_777_216) % 256,
                    Math.floor(index / 65_536) % 256,
                    Math.floor(index / 256) % 256,
                    index % 256,
                    ...Array.from({ length: 4 }, (_, offset) => copycat.int([table, field.name, "unique-bytes", offset], { max: 255, min: 0 })),
                ],
            };
        }

        case "date":
        case "timestamp": {
            return temporalDeal(now);
        }

        case "literal": {
            // A literal column accepts exactly one value, so a second unique row
            // is impossible by definition. Declaring the capacity lets the
            // planner say so with the row counts attached.
            return { capacity: 1, valueAt: () => metaOf(field.validator).value };
        }

        case "number": {
            // A time-named column with no declared bounds is epoch-ms, not a
            // quantity — the same rule the generator applies.
            if (constraints.maximum === undefined && constraints.minimum === undefined && isTimestampField(field.name)) {
                return temporalDeal(now);
            }

            return boundedNumeric(constraints, NUMBER_RANGE, field.name);
        }

        case "union": {
            // A union of literals is a closed domain — the same shape as an
            // enum, and the very case `docs/index.mdx` names ("a three-literal
            // `v.union()` … is refused at plan time"). The generator picks a
            // member per row WITH replacement, so without a deal here eight rows
            // over a two-literal union simply repeat and nothing refuses.
            const members = metaOf(field.validator).members ?? [];
            const literals = members.filter((member) => member.kind === "literal").map((member) => metaOf(member).value);

            if (literals.length > 0 && literals.length === members.length) {
                return domainDeal(literals, table, field.name);
            }

            return anonymousDeal;
        }

        default: {
            // `id`, `storage`, `array`, `object`, `record` — every one of these
            // derives from the per-cell hash (a uuid, or a composite built from
            // uuids), so it is already distinct per row.
            return anonymousDeal;
        }
    }
};

export { planUniqueDeal, planUniqueFkDeal };
export type { UniqueDeal };
