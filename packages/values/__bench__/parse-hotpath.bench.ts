import { bench, describe } from "vitest";

import { v } from "../src/v";

/*
 * Old-vs-new contrast for the parse hot-path optimizations:
 *
 * 1. v.object hoists Object.keys(shape) + toInternal() to construction time.
 * 2. object/array/record thread a single mutable path stack (push/pop) instead
 *    of spreading `[...context.path, segment]` per child.
 * 3. v.array builds its result with `push` onto an empty literal. It previously
 *    preallocated with `Array.from({ length })`, which has no V8 fast path and
 *    made this bench report the baseline as ~6x FASTER than the "optimized"
 *    parser — the regression that reading these numbers is meant to catch.
 *
 * Each `*-baseline` bench re-implements the pre-optimization parser inline over
 * the same fixtures so the relative win is demonstrable in one run. The
 * baselines call the real per-element validators (`v.string()` etc.) so only
 * the iteration/allocation strategy differs.
 *
 * READ THE OBJECT NUMBERS WITH CARE. `objectBaseline` reads each field with a
 * bare `input[key]`, while the real parser reads it through `Object.hasOwn` so a
 * declared field colliding with an `Object.prototype` member (`toString`,
 * `constructor`, …) reads as absent instead of inheriting the prototype's
 * function. That guard is a correctness fix, not overhead to remove, so the
 * object baseline is expected to stay marginally ahead — it is doing strictly
 * less work. Only a LARGE object-side gap indicates a real regression.
 */

type ParseContext = { path: (number | string)[] };

interface Internal {
    _parse: (value: unknown, context: ParseContext) => unknown;
    kind: string;
}

const asInternal = (validator: unknown): Internal => validator as Internal;

// ---- Fixtures (mirror validators.bench.ts) -------------------------------

const userShape = {
    active: v.boolean(),
    age: v.number(),
    email: v.string(),
    id: v.id("users"),
    name: v.string(),
};
const userObject = v.object(userShape);
const sampleUser = { active: true, age: 30, email: "a@b.c", id: "users:1", name: "alice" };

const stringElement = v.string();
const stringArray = v.array(stringElement);
const sampleStringArray = Array.from({ length: 32 }, (_, index) => `item-${String(index)}`);

const keyValidator = v.string();
const valueValidator = v.string();
const stringRecord = v.record(keyValidator, valueValidator);
const sampleRecord = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`key-${String(index)}`, `value-${String(index)}`]));

// ---- Baselines (pre-optimization shapes) ---------------------------------

const objectBaseline = (input: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};

    for (const key of Object.keys(userShape)) {
        const child = asInternal((userShape as Record<string, unknown>)[key]);
        const fieldValue = input[key];

        if (fieldValue === undefined && child.kind === "optional") {
            continue;
        }

        out[key] = child._parse(fieldValue, { path: [key] });
    }

    return out;
};

const arrayBaseline = (input: unknown[]): unknown[] => {
    const inner = asInternal(stringElement);
    const out: unknown[] = [];

    for (const [index, element] of input.entries()) {
        out.push(inner._parse(element, { path: [index] }));
    }

    return out;
};

const recordBaseline = (input: Record<string, unknown>): Record<string, unknown> => {
    const keyInternal = asInternal(keyValidator);
    const valueInternal = asInternal(valueValidator);
    const out = Object.create(null) as Record<string, unknown>;

    for (const key of Object.keys(input)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
            continue;
        }

        const parsedKey = keyInternal._parse(key, { path: [key] });

        out[parsedKey as string] = valueInternal._parse(input[key], { path: [key] });
    }

    return out;
};

describe("v.object — 5 fields", () => {
    bench("baseline (Object.keys + toInternal + path spread per field)", () => {
        objectBaseline(sampleUser);
    });

    bench("optimized (hoisted entries + mutable path)", () => {
        userObject.parse(sampleUser);
    });
});

describe("v.array(v.string()) — 32 items", () => {
    bench("baseline (entries() + push + path spread)", () => {
        arrayBaseline(sampleStringArray);
    });

    bench("optimized (push onto empty literal + mutable path)", () => {
        stringArray.parse(sampleStringArray);
    });
});

describe("v.record(v.string(), v.string()) — 16 entries", () => {
    bench("baseline (proto-key skip + double path spread)", () => {
        recordBaseline(sampleRecord);
    });

    bench("optimized (single push/pop per entry)", () => {
        stringRecord.parse(sampleRecord);
    });
});
