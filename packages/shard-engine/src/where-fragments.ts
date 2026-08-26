/**
 * The two representations `compileWhereSql` can emit.
 *
 * The compiler in `where-sql.ts` owns the *traversal* of a `WhereInput` tree —
 * which keys are structural, how `AND`/`OR` groups split, how the `in` budget is
 * divided, what an empty group means. That logic is shared by both ORM cores and
 * must never fork: two engines disagreeing about what a predicate means is a
 * correctness bug neither one's tests would catch.
 *
 * What CAN differ is the thing it builds. `@lunora/sql-store` needs a composable
 * drizzle `SQL`, because drizzle owns placeholder syntax across D1, PlanetScale,
 * Postgres and MySQL. The Durable Object needs none of that — it has exactly one
 * dialect — and paid dearly for it: building and rendering a read's statement
 * through drizzle measured 5.35µs against 0.10µs to assemble the same text and
 * parameters directly, on a read that costs ~10.8µs in total.
 *
 * So the traversal is parameterised over its output and this module supplies the
 * two builders. {@link drizzleFragments} is the default, which is why sql-store
 * needs no change at all.
 *
 * ## The invariant for any builder
 *
 * A fragment is text plus the values its placeholders bind, **in the order the
 * placeholders appear**. Every combinator here concatenates left to right and
 * appends parameters in the same order, because a builder that emits correct SQL
 * with transposed parameters produces a statement that still runs, still binds,
 * and quietly answers the wrong question.
 *
 * Values are never concatenated into text — that is what makes the compiler
 * injection-safe by construction, and it is the one property a new builder may
 * not trade away.
 */

/* eslint-disable no-restricted-syntax -- every `sql\`…\`` in the drizzle builder is a tagged-template SQL builder binding a value, not a string conversion; the rule misfires on the inner TemplateLiteral (same exemption as where-sql.ts). */
import { LunoraError } from "@lunora/errors";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { quoteIdentifier } from "../../../shared/quote-identifier";
import { isJsonSafe, sqliteInList } from "./drizzle";

/** A rendered SQL fragment: text, plus the values its `?` placeholders bind, in order. */
interface TextFragment {
    params: unknown[];
    text: string;
}

/**
 * The SQL-construction primitives the `WHERE` traversal needs, over whatever
 * representation `T` a caller wants back.
 *
 * Only leaf construction and composition live here. Anything that decides what a
 * predicate MEANS stays in the traversal.
 */
interface WhereFragments<T> {
    /** `<reference> <comparator> <bound value>` — the binary comparators. */
    binary: (reference: T, comparator: string, value: unknown) => T;

    /** `(<left>) AND|OR (<right>)` — the parenthesised join the depth-balancing split emits. */
    connect: (left: T, right: T, connector: "AND" | "OR") => T;

    /** `0 = 1` (never) / `1 = 1` (always) — the empty-`IN` and empty-`OR` sentinels. */
    constant: (value: boolean) => T;

    /** The dialect-default substring test, used when a strategy supplies no `containsExpr`. */
    contains: (reference: T, term: T) => T;

    /** The dialect-default `IN` / `NOT IN`, used when a strategy supplies no `inList`. */
    inList: (reference: T, items: ReadonlyArray<unknown>, negated: boolean, budget: number) => T;

    /** `NOT (<inner>)`. */
    negate: (inner: T) => T;

    /** `<reference> IS NULL` / `IS NOT NULL`. */
    nullCheck: (reference: T, negated: boolean) => T;

    /** Wrap an already-serialized value as a bound fragment. */
    value: (value: unknown) => T;
}

/** The composable-drizzle builder: what the compiler emitted before it was parameterised. */
const drizzleFragments: WhereFragments<SQL> = {
    binary: (reference, comparator, value) => sql`${reference} ${sql.raw(comparator)} ${value}`,
    constant: (value) => (value ? sql`1 = 1` : sql`0 = 1`),
    connect: (left, right, connector) => sql`(${left}) ${sql.raw(connector)} (${right})`,
    contains: (reference, term) => sql`instr(lower(${reference}), lower(${term})) > 0`,
    inList: (reference, items, negated, budget) => sqliteInList(reference, items, negated, budget),
    negate: (inner) => sql`NOT (${inner})`,
    nullCheck: (reference, negated) => (negated ? sql`${reference} IS NOT NULL` : sql`${reference} IS NULL`),
    value: (value) => sql`${value}`,
};

/** Concatenate fragments left to right, keeping parameters in placeholder order. */
const joinText = (...parts: (string | TextFragment)[]): TextFragment => {
    let text = "";
    const params: unknown[] = [];

    for (const part of parts) {
        if (typeof part === "string") {
            text += part;
        } else {
            text += part.text;
            params.push(...part.params);
        }
    }

    return { params, text };
};

/** A single bound value: one placeholder, one parameter. */
const bound = (value: unknown): TextFragment => {
    return { params: [value], text: "?" };
};

/** Raw SQL text with no bound values — a column reference, an identifier, an ordering. */
const rawText = (text: string): TextFragment => {
    return { params: [], text };
};

/** A quoted identifier as a fragment, matching drizzle's `sql.identifier`. */
const identifierText = (name: string): TextFragment => rawText(quoteIdentifier(name));

/**
 * The text builder used by the Durable Object's reads.
 *
 * Mirrors {@link drizzleFragments} operation for operation — the text each emits
 * is asserted byte-identical in `__tests__/where-fragments.test.ts` over every
 * operator and a generated predicate corpus, because "it produces the same SQL"
 * is the entire basis for using this instead.
 */
const textFragments: WhereFragments<TextFragment> = {
    binary: (reference, comparator, value) => joinText(reference, " ".concat(comparator, " "), bound(value)),
    constant: (value) => rawText(value ? "1 = 1" : "0 = 1"),
    connect: (left, right, connector) => joinText("(", left, ") ".concat(connector, " ("), right, ")"),
    contains: (reference, term) => joinText("instr(lower(", reference, "), lower(", term, ")) > 0"),

    inList: (reference, items, negated, budget) => {
        const keyword = negated ? " NOT IN " : " IN ";

        // Refuses exactly what `sqliteInList` refuses, with the same message: a
        // list too wide to bind as placeholders whose values JSON cannot carry
        // has no bounded form, and silently truncating it would drop matches.
        if (items.length > budget && !items.every((item) => isJsonSafe(item))) {
            throw new LunoraError(
                "BAD_REQUEST",
                `an "in" list of ${String(items.length)} values holds a value JSON cannot carry (bytes, a non-finite number, or malformed text), so it cannot be bound as one parameter — and ${String(items.length)} placeholders exceed SQLite's per-statement cap of 100 on Durable Objects and D1. Narrow the list to ${String(budget)} values or fewer.`,
            );
        }

        if (items.length <= budget) {
            const parts: (string | TextFragment)[] = [reference, keyword, "("];

            for (const [index, item] of items.entries()) {
                if (index > 0) {
                    parts.push(", ");
                }

                parts.push(bound(item));
            }

            parts.push(")");

            return joinText(...parts);
        }

        // The wide form binds the whole list as ONE json parameter, so the
        // statement stays under the placeholder cap however long the list is.
        return joinText(reference, keyword, '(SELECT "value" FROM json_each(', bound(JSON.stringify(items)), "))");
    },

    negate: (inner) => joinText("NOT (", inner, ")"),
    nullCheck: (reference, negated) => joinText(reference, negated ? " IS NOT NULL" : " IS NULL"),
    value: bound,
};

export type { TextFragment, WhereFragments };
export { bound, drizzleFragments, identifierText, joinText, rawText, textFragments };
