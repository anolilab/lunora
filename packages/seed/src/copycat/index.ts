import { faker } from "@faker-js/faker";

import { hashInput } from "./hash";

/**
 * The internal, deterministic fake-data generator — a rebuilt
 * [`copycat`](https://github.com/supabase-community/copycat) on top of
 * `@faker-js/faker`. **Private to `@lunora/seed`**: it is not re-exported from
 * the package root.
 *
 * Every method takes an `input` (any JSON-serializable value), hashes it to a
 * faker seed via {@link hashInput}, seeds the shared faker singleton, and returns
 * one value. Because each call re-seeds from its own input, results are stable
 * and independent of call order: `copycat.email("a")` is always the same string,
 * and is unaffected by any `copycat.*` call made before it.
 */

/** Seed faker from `input`, then produce a value. The heart of determinism. */
const seeded = <T>(input: unknown, produce: () => T): T => {
    faker.seed(hashInput(input));

    return produce();
};

/** A count expressed as an exact number or an inclusive `[min, max]` range. */
type Range = number | [number, number];

/** Resolve a {@link Range} to a concrete count, deterministically when a range. */
const resolveCount = (input: unknown, range: Range): number => {
    if (typeof range === "number") {
        return range;
    }

    const [min, max] = range;

    return seeded(["__count__", input], () => faker.number.int({ max, min }));
};

/** Character-class probes for {@link copycat.scramble}, hoisted to avoid per-call recompilation. */
const LOWER_ALPHA = /[a-z]/;
const UPPER_ALPHA = /[A-Z]/;
const DIGIT = /\d/;

const copycat = {
    bool(input: unknown): boolean {
        return seeded(input, () => faker.datatype.boolean());
    },

    city(input: unknown): string {
        return seeded(input, () => faker.location.city());
    },

    country(input: unknown): string {
        return seeded(input, () => faker.location.country());
    },

    email(input: unknown): string {
        return seeded(input, () => faker.internet.email().toLowerCase());
    },

    firstName(input: unknown): string {
        return seeded(input, () => faker.person.firstName());
    },

    float(input: unknown, options?: { fractionDigits?: number; max?: number; min?: number }): number {
        const { fractionDigits = 2, max = 1000, min = 0 } = options ?? {};

        return seeded(input, () => faker.number.float({ fractionDigits, max, min }));
    },

    fullName(input: unknown): string {
        return seeded(input, () => faker.person.fullName());
    },

    int(input: unknown, options?: { max?: number; min?: number }): number {
        const { max = 1000, min = 0 } = options ?? {};

        return seeded(input, () => faker.number.int({ max, min }));
    },

    lastName(input: unknown): string {
        return seeded(input, () => faker.person.lastName());
    },

    /** Pick the array element corresponding to `input`. Returns `undefined` for an empty array. */
    oneOf<T>(input: unknown, values: ReadonlyArray<T>): T | undefined {
        if (values.length === 0) {
            return undefined;
        }

        return seeded(input, () => faker.helpers.arrayElement(values as T[]));
    },

    paragraph(input: unknown): string {
        return seeded(input, () => faker.lorem.paragraph());
    },

    password(input: unknown): string {
        return seeded(input, () => faker.internet.password());
    },

    phoneNumber(input: unknown): string {
        return seeded(input, () => faker.phone.number());
    },

    /**
     * Scramble a string in place: letters become seeded letters (case
     * preserved), digits become seeded digits, every other character is kept.
     * Length is preserved. Characters listed in `preserve` pass through untouched.
     */
    scramble(input: string, options?: { preserve?: ReadonlyArray<string> }): string {
        const preserve = new Set(options?.preserve);

        return Array.from({ length: input.length }, (_unused, index) => {
            const char = input.charAt(index);

            if (preserve.has(char)) {
                return char;
            }

            if (LOWER_ALPHA.test(char)) {
                return seeded([input, index, "l"], () => faker.string.alpha({ casing: "lower", length: 1 }));
            }

            if (UPPER_ALPHA.test(char)) {
                return seeded([input, index, "u"], () => faker.string.alpha({ casing: "upper", length: 1 }));
            }

            if (DIGIT.test(char)) {
                return seeded([input, index, "d"], () => String(faker.number.int({ max: 9, min: 0 })));
            }

            return char;
        }).join("");
    },

    sentence(input: unknown, options?: { max?: number; min?: number }): string {
        return seeded(input, () => faker.lorem.sentence(options ? { max: options.max ?? 8, min: options.min ?? 3 } : undefined));
    },

    slug(input: unknown): string {
        return seeded(input, () => faker.lorem.slug());
    },

    streetAddress(input: unknown): string {
        return seeded(input, () => faker.location.streetAddress());
    },

    /**
     * Call `produce` once per element for a deterministic count within `range`,
     * passing each a distinct sub-input so the elements differ but stay stable.
     */
    times<T>(input: unknown, range: Range, produce: (itemInput: unknown) => T): T[] {
        const count = resolveCount(input, range);
        const out: T[] = [];

        for (let index = 0; index < count; index += 1) {
            out.push(produce([input, index]));
        }

        return out;
    },

    url(input: unknown): string {
        return seeded(input, () => faker.internet.url());
    },

    username(input: unknown): string {
        return seeded(input, () => faker.internet.username());
    },

    uuid(input: unknown): string {
        return seeded(input, () => faker.string.uuid());
    },

    word(input: unknown): string {
        return seeded(input, () => faker.lorem.word());
    },
};

export { copycat };

export { hashInput, setHashKey } from "./hash";
