/**
 * `ORDER BY` term helpers, shared by the window `OVER (...)` clause and the
 * builder's `ORDER BY` / set-operation tail.
 */

import { Sql, toText } from "./sql";

/** A single `ORDER BY` term: a bare column/expression (ASC) or one tagged via {@link asc} / {@link desc}. */
export type OrderTerm = Sql | string | { dir: "ASC" | "DESC"; expr: Sql | string };

/** Tag an order term ascending — `asc("total")` → `total ASC`. */
export const asc = (expr: Sql | string): OrderTerm => {
    return { dir: "ASC", expr };
};

/** Tag an order term descending — `desc("total")` → `total DESC`. */
export const desc = (expr: Sql | string): OrderTerm => {
    return { dir: "DESC", expr };
};

/** Render one {@link OrderTerm} to SQL. */
export const renderOrderTerm = (term: OrderTerm): string => {
    if (typeof term === "string" || term instanceof Sql) {
        return toText(term);
    }

    return `${toText(term.expr)} ${term.dir}`;
};
