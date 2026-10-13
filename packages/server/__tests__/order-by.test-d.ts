/**
 * Compile-time only (included by `tsc --noEmit`): an `orderBy` entry takes a plain direction, or
 * `{ sort, nulls }` to place NULLs, and rejects anything else.
 */
import type { OrderBy } from "../src/data-model";

interface Row {
    dueAt?: number;
    title: string;
}

const check = (): ReadonlyArray<OrderBy<Row>> => [
    { dueAt: "asc" },
    { dueAt: { nulls: "last", sort: "asc" } },
    { dueAt: { nulls: "first", sort: "desc" }, title: "asc" },
    // @ts-expect-error -- `nulls` needs a `sort` beside it
    { dueAt: { nulls: "last" } },
    // @ts-expect-error -- `nulls` is "first" or "last"
    { dueAt: { nulls: "middle", sort: "asc" } },
    // @ts-expect-error -- not a column
    { missing: "asc" },
];

export default check;
