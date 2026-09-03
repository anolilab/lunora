import { LunoraError } from "@lunora/errors";
import type { Validator } from "@lunora/values";

import { copycat } from "./copycat";
import { metaOf, unwrapOptional } from "./introspect";

/**
 * Generate one deterministic fake value for a validator. The `input` is the
 * copycat hash seed — pass something stable and unique per (table, row, field)
 * so the same plan always reproduces, e.g. `["users", 3, "email"]`.
 *
 * Field-name heuristics come first for `string` columns (a column called `email`
 * becomes an email, `firstName` a first name, …); otherwise the value is chosen
 * by validator `kind`. Foreign keys (`v.id("table")`) are NOT resolved here — the
 * plan layer assigns those from already-seeded parent ids; if a raw `id` column
 * reaches this function it falls back to a fresh uuid.
 */

/** JSON Schema constraint fragment a `.check()` / `.meta()` may have attached. */
interface Constraints {
    enum?: ReadonlyArray<unknown>;
    /** `.email()` / `.url()` — a named JSON Schema format the value must satisfy. */
    format?: string;
    maximum?: number;
    maxLength?: number;
    minimum?: number;
    minLength?: number;
    /** `.pattern()` — a regular expression source the value must match. */
    pattern?: string;
}

const constraintsOf = (validator: Validator): Constraints => metaOf(validator).constraints ?? {};

/**
 * Field-name → generator heuristics, tried in order; the first rule whose any
 * keyword is a substring of the (lower-cased) column name wins. Order matters:
 * `firstname`/`lastname`/`username` precede the broad `name` rule so a `username`
 * column doesn't collapse to a full name.
 */
const STRING_HEURISTICS: ReadonlyArray<{ generate: (input: unknown) => string; keywords: ReadonlyArray<string> }> = [
    { generate: (input) => copycat.email(input), keywords: ["email"] },
    { generate: (input) => copycat.firstName(input), keywords: ["firstname"] },
    { generate: (input) => copycat.lastName(input), keywords: ["lastname", "surname"] },
    { generate: (input) => copycat.username(input), keywords: ["username"] },
    { generate: (input) => copycat.fullName(input), keywords: ["name"] },
    { generate: (input) => copycat.sentence(input, { max: 5, min: 2 }), keywords: ["title"] },
    { generate: (input) => copycat.url(input), keywords: ["url", "link", "image", "avatar"] },
    { generate: (input) => copycat.phoneNumber(input), keywords: ["phone"] },
    { generate: (input) => copycat.paragraph(input), keywords: ["description", "bio", "body", "content", "text"] },
    { generate: (input) => copycat.slug(input), keywords: ["slug", "key", "code"] },
    { generate: (input) => copycat.city(input), keywords: ["city"] },
    { generate: (input) => copycat.country(input), keywords: ["country"] },
    { generate: (input) => copycat.streetAddress(input), keywords: ["address", "street"] },
    { generate: (input) => copycat.password(input), keywords: ["password", "secret", "token"] },
];

/**
 * Column-name suffixes/keywords that mean "this number is a moment in time".
 *
 * Lunora stores dates as epoch-ms NUMBERS (see the `date`/`timestamp` arm
 * below), so a `createdAt: v.number()` column is indistinguishable from a
 * quantity by validator kind alone — and seeding it as `641` produces rows no
 * date filter, sort, or range search can do anything with. The name is the only
 * signal available, and it is the same signal the string heuristics already use.
 *
 * Bare `time` is deliberately NOT in this set: `responseTime`, `loadTime`, and
 * `elapsedTime` are durations, and seeding a duration as ~1.7e12 is worse than
 * leaving it a plain number. A false negative here is boring data; a false
 * positive is nonsense data. `timestamp` stays because it is unambiguous.
 */
const TIMESTAMP_WORDS: ReadonlySet<string> = new Set(["at", "date", "deadline", "expires", "expiry", "since", "timestamp", "until"]);

/** camelCase boundary — `lastSeenAt` → `last Seen At`. Module scope so it is compiled once. */
const CAMEL_BOUNDARY = /([a-z\d])([A-Z])/gu;

/** `_`, `-`, and whitespace separators. */
const WORD_SEPARATORS = /[\s_-]+/u;

/** Split a column name into lower-cased words across camelCase and `_`/`-`/space boundaries: `lastSeenAt` becomes `last`, `seen`, `at`. */
const wordsOf = (fieldName: string): string[] =>
    fieldName
        .replaceAll(CAMEL_BOUNDARY, "$1 $2")
        .split(WORD_SEPARATORS)
        .filter((word) => word !== "")
        .map((word) => word.toLowerCase());

/**
 * Default numeric bounds, used when a column declares none. Named (rather than
 * inlined at the two `??` sites) because `@lunora/seed`'s unique-value planner
 * has to know the exact range a column will draw from to decide how many
 * distinct rows it can produce — an inlined literal would drift.
 */
const NUMBER_RANGE = { max: 1000, min: 0 } as const;

/** Default `v.bigint()` bounds. Well within `Number.MAX_SAFE_INTEGER`, so the plain-number wire form loses no precision. */
const BIGINT_RANGE = { max: 1_000_000, min: 0 } as const;

/** How far back a generated timestamp may fall. Six months is wide enough that a `YYYY-MM` search selects a real subset rather than everything or nothing. */
const TIMESTAMP_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Whether `fieldName` names a moment in time.
 *
 * Matches on the LAST WORD, not on a substring: `format` ends in "at",
 * `candidateId` contains "date", and `timeout` contains "time" — none of them is
 * a timestamp, and a latitude of 1.78e12 is not a latitude.
 * Naming a column `somethingAt` / `somethingDate` is the convention this leans on.
 */
const isTimestampField = (fieldName: string): boolean => {
    const words = wordsOf(fieldName);
    const last = words.at(-1);

    return last !== undefined && TIMESTAMP_WORDS.has(last);
};

/**
 * A deterministic epoch-ms within {@link TIMESTAMP_WINDOW_MS} before `now`.
 *
 * `now` is injected rather than read here — and is REQUIRED, with no default —
 * so a plan stays reproducible: the same seed plus the same `now` yields the
 * same rows, which is what makes a seeded screenshot or a bug report
 * replayable. A default here would let a caller silently forget to pass one
 * and quietly lose the determinism the package promises.
 */
const generateTimestamp = (input: unknown, now: number): number => now - copycat.int(input, { max: TIMESTAMP_WINDOW_MS, min: 0 });

/**
 * Refuse a column the seeder cannot invent a conforming value for, naming it.
 *
 * Falling through to the generic `copycat.word` would produce a value the very
 * next `ctx.db.insert` rejects, reported as a validation failure on a row
 * nobody wrote by hand. The `.unique()` twin (`planUniqueDeal`) refuses the
 * same shapes for the same reason, so the two paths agree on which columns are
 * seedable at all.
 */
const refuseColumn = (fieldName: string, why: string): never => {
    throw new LunoraError(
        "INTERNAL",
        `@lunora/seed: column "${fieldName}" ${why}. ` +
            `Supply a value via \`overrides\` (\`{ <table>: { ${fieldName}: … } }\`) or restrict the run with \`only\` so the table is skipped.`,
    );
};

/**
 * Generators for the JSON Schema `format` keywords a string column can declare
 * (`v.string().email()` → `email`, `v.string().url()` → `uri`). A declared
 * format is authoritative over the field-name heuristics below — the column's
 * own validator re-checks it on insert, and it is the same rule the `number`
 * arm applies to declared bounds ("a schema that says `minimum: 0, maximum: 5`
 * means a rating, whatever the column is called").
 */
const FORMAT_GENERATORS: Readonly<Record<string, (input: unknown) => string>> = {
    email: (input) => copycat.email(input),
    uri: (input) => copycat.url(input),
};

/**
 * Generate the base string for a column, honouring a declared shape over the
 * field-name heuristics and refusing outright when the shape is one the seeder
 * cannot satisfy.
 */
const generateStringBody = (fieldName: string, input: unknown, constraints: Constraints): string => {
    const { format, pattern } = constraints;

    if (pattern !== undefined) {
        return refuseColumn(
            fieldName,
            `is constrained to the pattern /${pattern}/, and the seeder cannot invent a value matching an arbitrary regular expression`,
        );
    }

    if (format !== undefined) {
        const generate = FORMAT_GENERATORS[format];

        return generate === undefined ? refuseColumn(fieldName, `declares format "${format}", which the seeder has no generator for`) : generate(input);
    }

    const lower = fieldName.toLowerCase();
    const rule = STRING_HEURISTICS.find((entry) => entry.keywords.some((keyword) => lower.includes(keyword)));

    return rule === undefined ? copycat.word(input) : rule.generate(input);
};

/** Heuristic string generation by column name (mirrors the studio data generator). */
const generateString = (fieldName: string, input: unknown, constraints: Constraints): string => {
    const value = generateStringBody(fieldName, input, constraints);

    const { maxLength, minLength } = constraints;

    if (maxLength !== undefined && minLength !== undefined && minLength > maxLength) {
        throw new LunoraError(
            "INTERNAL",
            `Seed constraint error for field "${fieldName}": minLength (${String(minLength)}) > maxLength (${String(maxLength)}). Adjust the schema constraints.`,
        );
    }

    // Truncate first so we never exceed maxLength.
    const truncated = maxLength !== undefined && value.length > maxLength ? value.slice(0, maxLength) : value;

    // Pad to minLength by repeating the generated value until long enough.
    if (minLength !== undefined && truncated.length < minLength) {
        return truncated.padEnd(minLength, truncated.length > 0 ? truncated : "x");
    }

    return truncated;
};

const generateValue = (validator: Validator, fieldName: string, input: unknown, now: number): unknown => {
    const inner = unwrapOptional(validator);
    const constraints = constraintsOf(inner);

    if (constraints.enum !== undefined && constraints.enum.length > 0) {
        return copycat.oneOf(input, constraints.enum);
    }

    switch (inner.kind) {
        case "any": {
            return copycat.word(input);
        }

        case "array": {
            const element = metaOf(inner).inner;

            if (element === undefined) {
                return [];
            }

            return copycat.times(input, [1, 3], (itemInput) => generateValue(element, fieldName, itemInput, now));
        }

        case "bigint": {
            // Emit a plain number so the value survives JSON serialisation on every
            // adapter path (CLI NDJSON, studio JSON response, testing harness). The
            // default range [0, 1_000_000] is well within Number.MAX_SAFE_INTEGER,
            // so no integer precision is lost. Adapters that write to the DO's
            // SQLite layer must coerce this back to BigInt before insert (see
            // testing.ts). Declared bounds win over the default, the same as the
            // `number` arm and the `.unique()` twin's `boundedNumeric`.
            return copycat.int(input, { max: constraints.maximum ?? BIGINT_RANGE.max, min: constraints.minimum ?? BIGINT_RANGE.min });
        }

        case "boolean": {
            return copycat.bool(input);
        }

        case "bytes": {
            // Emit a plain number[] so the value survives JSON serialisation on
            // every adapter path without a custom replacer. Adapters that write
            // directly to the DO (see testing.ts) must coerce this back to an
            // ArrayBuffer / Uint8Array before insert; JSON-over-HTTP adapters
            // (CLI NDJSON, studio) already transmit byte arrays to the worker,
            // which reconstructs the buffer from the wire representation.
            return Array.from({ length: 8 }, (_, index) => copycat.int([input, index], { max: 255, min: 0 }));
        }

        case "date":
        case "timestamp": {
            // Lunora stores dates as epoch-ms numbers, anchored on the caller's
            // `now` like every other time-valued column — the `number` arm's
            // `isTimestampField` branch below, and the `.unique()` twin's
            // `temporalDeal`. A generator-local window would put two spellings
            // of the same column (`v.timestamp()` and `v.timestamp().unique()`)
            // decades apart, and would ignore the one input `SeedOptions.now`
            // exists to pin.
            return generateTimestamp(input, now);
        }

        case "from": {
            // `v.from(externalSchema)` delegates to a Standard Schema library, and
            // there is nothing here to introspect — the seeder cannot know whether
            // it wants a UUID, an ISO date, or a 20-field object.
            return refuseColumn(
                fieldName,
                "is a v.from() validator, whose external Standard Schema the seeder cannot introspect to invent a conforming value (give the column a concrete v.* type instead)",
            );
        }

        case "id": {
            // Reached only when the FK has no seeded parent — emit a placeholder id.
            return copycat.uuid(input);
        }

        case "literal": {
            return metaOf(inner).value;
        }

        case "null": {
            // eslint-disable-next-line unicorn/no-null -- null is the domain value of a v.null() column
            return null;
        }

        case "number": {
            const { maximum, minimum } = constraints;

            // A time-named column with no explicit bounds is epoch-ms, not a
            // quantity. Declared bounds win — a schema that says `minimum: 0,
            // maximum: 5` means a rating, whatever the column is called.
            if (maximum === undefined && minimum === undefined && isTimestampField(fieldName)) {
                return generateTimestamp(input, now);
            }

            if (maximum !== undefined && minimum !== undefined && minimum > maximum) {
                throw new LunoraError(
                    "INTERNAL",
                    `Seed constraint error for field "${fieldName}": minimum (${String(minimum)}) > maximum (${String(maximum)}). Adjust the schema constraints.`,
                );
            }

            const min = minimum ?? NUMBER_RANGE.min;
            const max = maximum ?? NUMBER_RANGE.max;

            // `v.number()` is a float column, so honour non-integer bounds with a
            // float (faker's integer generator rejects fractional min/max).
            if (!Number.isInteger(min) || !Number.isInteger(max)) {
                return copycat.float(input, { max, min });
            }

            return copycat.int(input, { max, min });
        }

        case "object": {
            const shape = metaOf(inner).shape ?? {};

            return Object.fromEntries(Object.entries(shape).map(([key, child]) => [key, generateValue(child, key, [input, key], now)]));
        }

        case "record": {
            const { keyValidator, valueValidator } = metaOf(inner);
            const entries = copycat.times(input, [1, 3], (itemInput) => {
                // `v.record(keyValidator, valueValidator)` re-parses every key
                // through `keyValidator`, so honour any key constraints (minLength,
                // format, …) rather than emitting a plain lorem word that the
                // writer's validation would reject. Keys must be strings.
                const key = keyValidator === undefined ? copycat.word(["k", itemInput]) : String(generateValue(keyValidator, fieldName, ["k", itemInput], now));
                const value = valueValidator === undefined ? copycat.word(["v", itemInput]) : generateValue(valueValidator, fieldName, ["v", itemInput], now);

                return [key, value] as const;
            });

            return Object.fromEntries(entries);
        }

        case "storage": {
            return `seed/${copycat.uuid(input)}`;
        }

        case "string": {
            return generateString(fieldName, input, constraints);
        }

        case "union": {
            const members = metaOf(inner).members ?? [];
            const chosen = copycat.oneOf(input, members);

            return chosen === undefined ? copycat.word(input) : generateValue(chosen, fieldName, [input, "u"], now);
        }

        default: {
            return copycat.word(input);
        }
    }
};

export { BIGINT_RANGE, constraintsOf, generateValue, isTimestampField, NUMBER_RANGE, TIMESTAMP_WINDOW_MS };
export type { Constraints };
