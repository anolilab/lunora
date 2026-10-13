/**
 * Compile-time only (included by `tsc --noEmit`): `PatchValues` lets a number
 * column take an arithmetic operator and a boolean column take `{ toggle: true }`,
 * and nothing else takes either.
 */
import type { PatchValues } from "../src/data-model";

interface Row {
    flag: boolean;
    label: string;
    maybe?: null | number;
    mixed: number | string;
    n: number;
    tier: 1 | 2 | 3;
}

const check = (): ReadonlyArray<PatchValues<Row>> => [
    { n: { increment: 1 } },
    { n: { decrement: 1 } },
    { n: { multiply: 2 } },
    { n: { divide: 2 } },
    { maybe: { increment: 1 } },
    { flag: { toggle: true } },
    { flag: true, label: "x", n: 3 },
    // @ts-expect-error -- a string column takes no operator
    { label: { increment: 1 } },
    // @ts-expect-error -- `toggle` is for booleans
    { n: { toggle: true } },
    // @ts-expect-error -- a boolean toggles, it does not count
    { flag: { increment: 1 } },
    // @ts-expect-error -- `toggle` must be `true`
    { flag: { toggle: false } },
    // @ts-expect-error -- a literal-union column cannot be guaranteed to stay in its set
    { tier: { increment: 1 } },
    // @ts-expect-error -- a column that may hold a string is not a number column
    { mixed: { increment: 1 } },
    // @ts-expect-error -- one operator at a time
    { n: { decrement: 1, increment: 1 } },
    // @ts-expect-error -- the operand is a number
    { n: { increment: "1" } },
];

export default check;
