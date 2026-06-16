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
    maximum?: number;
    maxLength?: number;
    minimum?: number;
    minLength?: number;
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

/** Heuristic string generation by column name (mirrors the studio data generator). */
const generateString = (fieldName: string, input: unknown, constraints: Constraints): string => {
    const lower = fieldName.toLowerCase();
    const rule = STRING_HEURISTICS.find((entry) => entry.keywords.some((keyword) => lower.includes(keyword)));
    const value = rule === undefined ? copycat.word(input) : rule.generate(input);

    const { maxLength, minLength } = constraints;

    if (maxLength !== undefined && minLength !== undefined && minLength > maxLength) {
        throw new Error(
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

const generateValue = (validator: Validator, fieldName: string, input: unknown): unknown => {
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

            return copycat.times(input, [1, 3], (itemInput) => generateValue(element, fieldName, itemInput));
        }

        case "bigint": {
            // Emit a plain number so the value survives JSON serialisation on every
            // adapter path (CLI NDJSON, studio JSON response, testing harness). The
            // range [0, 1_000_000] is well within Number.MAX_SAFE_INTEGER, so no
            // integer precision is lost. Adapters that write to the DO's SQLite
            // layer must coerce this back to BigInt before insert (see testing.ts).
            return copycat.int(input, { max: 1_000_000, min: 0 });
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
            // Lunora stores dates as epoch-ms numbers.
            return new Date(copycat.dateString(input)).getTime();
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
            return copycat.int(input, { max: constraints.maximum ?? 1000, min: constraints.minimum ?? 0 });
        }

        case "object": {
            const shape = metaOf(inner).shape ?? {};

            return Object.fromEntries(Object.entries(shape).map(([key, child]) => [key, generateValue(child, key, [input, key])]));
        }

        case "record": {
            const { valueValidator } = metaOf(inner);
            const entries = copycat.times(input, [1, 3], (itemInput) => {
                const key = copycat.word(["k", itemInput]);
                const value = valueValidator === undefined ? copycat.word(["v", itemInput]) : generateValue(valueValidator, fieldName, ["v", itemInput]);

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

            return chosen === undefined ? copycat.word(input) : generateValue(chosen, fieldName, [input, "u"]);
        }

        default: {
            return copycat.word(input);
        }
    }
};

// eslint-disable-next-line import/prefer-default-export -- named export: the package barrel re-exports by name, per the repo's no-default-mixing convention
export { generateValue };
