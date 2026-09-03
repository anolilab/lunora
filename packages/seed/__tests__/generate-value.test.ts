import type { Validator } from "@lunora/values";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { generateValue } from "../src/generate-value";

/** A fixed epoch so no assertion depends on the wall clock. */
const NOW = 1_785_000_000_000;

/** Build a validator annotated with JSON-Schema constraint metadata (mirrors how `.check()` attaches `constraints`). */
const withConstraints = (validator: Validator, constraints: Record<string, unknown>): Validator => {
    const inner = validator as { _meta?: Record<string, unknown> };

    return {
        ...validator,
        _meta: { ...inner._meta, constraints },
    } as unknown as Validator;
};

describe("generateValue — string minLength", () => {
    it("generates a string at least minLength chars long (regression: minLength was ignored)", () => {
        expect.hasAssertions();

        const validator = withConstraints(v.string(), { minLength: 20 });
        const value = generateValue(validator, "slug", "test-input", NOW);

        expect(typeof value).toBe("string");
        expect((value as string).length).toBeGreaterThanOrEqual(20);
    });

    it("truncates to maxLength when both constraints apply", () => {
        expect.hasAssertions();

        const validator = withConstraints(v.string(), { maxLength: 5, minLength: 3 });
        const value = generateValue(validator, "code", "test-input", NOW);

        expect(typeof value).toBe("string");
        expect((value as string).length).toBeGreaterThanOrEqual(3);
        expect((value as string).length).toBeLessThanOrEqual(5);
    });

    it("throws when minLength > maxLength (impossible constraint)", () => {
        expect.hasAssertions();

        const validator = withConstraints(v.string(), { maxLength: 3, minLength: 10 });

        expect(() => generateValue(validator, "code", "test-input", NOW)).toThrow(/minLength.*maxLength/u);
    });
});

describe("generateValue — number constraints", () => {
    it("throws when minimum > maximum (impossible constraint, regression: was a raw faker error)", () => {
        expect.hasAssertions();

        const validator = withConstraints(v.number(), { maximum: 10, minimum: 100 });

        expect(() => generateValue(validator, "score", "test-input", NOW)).toThrow(/minimum.*maximum/u);
    });

    it("uses a float when the bounds are non-integers", () => {
        expect.hasAssertions();

        const validator = withConstraints(v.number(), { maximum: 1, minimum: 0.5 });
        const value = generateValue(validator, "ratio", "test-input", NOW) as number;

        expect(typeof value).toBe("number");
        expect(value).toBeGreaterThanOrEqual(0.5);
        expect(value).toBeLessThanOrEqual(1);
    });
});

describe("generateValue — record key validator", () => {
    it("generates keys via the key validator, honouring its constraints (regression: key validator was ignored)", () => {
        expect.hasAssertions();

        const keyValidator = withConstraints(v.string(), { minLength: 8 }) as unknown as Validator<string>;
        const validator = v.record(keyValidator, v.boolean());
        const value = generateValue(validator, "flags", "test-input", NOW) as Record<string, unknown>;
        const keys = Object.keys(value);

        expect(keys.length).toBeGreaterThan(0);
        expect(keys.every((key) => key.length >= 8)).toBe(true);
        expect(Object.values(value).every((entry) => typeof entry === "boolean")).toBe(true);
    });
});

describe("generateValue — bigint wire representation", () => {
    it("emits a plain number (not BigInt) so the value is JSON-serialisable", () => {
        expect.hasAssertions();

        const value = generateValue(v.bigint(), "count", "test-input", NOW);

        expect(typeof value).toBe("number");
        // Must be an integer and within the safe integer range.
        expect(Number.isInteger(value)).toBe(true);
        expect(value as number).toBeGreaterThanOrEqual(0);
        expect(value as number).toBeLessThanOrEqual(1_000_000);
        // Must not throw in JSON.stringify (BigInt would throw).
        expect(() => JSON.stringify(value)).not.toThrow();
    });
});

describe("generateValue — bytes wire representation", () => {
    it("emits a number[] that survives JSON round-trip without a custom replacer", () => {
        expect.hasAssertions();

        const value = generateValue(v.bytes(), "data", "test-input", NOW);

        expect(Array.isArray(value)).toBe(true);
        expect((value as number[]).every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)).toBe(true);

        // Must survive JSON.stringify/parse without any custom replacer. The
        // JSON round-trip is the property under test (the wire path), so
        // structuredClone is deliberately not used here.
        // eslint-disable-next-line unicorn/prefer-structured-clone -- asserting JSON-wire survival, not deep-cloning
        const roundTripped = JSON.parse(JSON.stringify(value)) as unknown;

        expect(roundTripped).toEqual(value);
    });

    it("produces a revivable ArrayBuffer via Uint8Array.from for the testing adapter", () => {
        expect.hasAssertions();

        const value = generateValue(v.bytes(), "payload", "test-input", NOW) as number[];
        const { buffer } = Uint8Array.from(value);

        expect(buffer).toBeInstanceOf(ArrayBuffer);
        expect(new Uint8Array(buffer)).toHaveLength(value.length);
    });
});

describe("generateValue — v.date() / v.timestamp()", () => {
    const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;

    it.each([
        ["date", v.date()],
        ["timestamp", v.timestamp()],
    ])("anchors a v.%s() column on the caller's `now` rather than a generator-local window", (kind, validator) => {
        expect.assertions(2);

        // Regression: this arm drew from faker's hard-coded 1980–2020 window and
        // ignored `now` entirely, so `expiresAt: v.timestamp()` seeded 2012 while
        // `expiresAt: v.timestamp().unique()` (which uses `now`) seeded 2026.
        const value = generateValue(validator, "expiresAt", `${kind}-input`, NOW) as number;

        expect(value).toBeLessThanOrEqual(NOW);
        expect(value).toBeGreaterThanOrEqual(NOW - SIX_MONTHS_MS);
    });

    it("shifts with `now` instead of staying pinned to a fixed calendar window", () => {
        expect.assertions(1);

        const later = NOW + 10 * 365 * 24 * 60 * 60 * 1000;

        expect(generateValue(v.timestamp(), "expiresAt", "same-input", later)).toBe(
            (generateValue(v.timestamp(), "expiresAt", "same-input", NOW) as number) + (later - NOW),
        );
    });
});

describe("generateValue — refined string columns", () => {
    it("refuses a pattern-constrained column by name instead of seeding a value its own validator rejects", () => {
        expect.assertions(2);

        // The `.unique()` twin (`stringDeal`) and the `v.from()` arm both refuse
        // loudly for this reason; the ordinary path used to emit a bare lorem
        // word — `sku` → "audeo", `safeParse().ok === false`.
        const sku = v.string().pattern(/^SKU-\d{4}$/u);

        expect(() => generateValue(sku, "sku", "input", NOW)).toThrow(/sku/u);
        expect(() => generateValue(sku, "sku", "input", NOW)).toThrow(/pattern/u);
    });

    it("refuses a column declaring a format it has no generator for", () => {
        expect.assertions(1);

        expect(() => generateValue(withConstraints(v.string(), { format: "ipv6" }), "peer", "input", NOW)).toThrow(/format "ipv6"/u);
    });

    it.each([
        ["homepage", v.string().url(), (value: string) => new URL(value).protocol],
        ["contact", v.string().email(), (value: string) => (/^[^@\s]+@[^@\s]+$/u.test(value) ? "https:" : "")],
    ])("generates a conforming value for a declared format on %s, whose name no heuristic matches", (field, validator, probe) => {
        expect.assertions(1);

        // A declared format outranks the field-name heuristics: neither
        // `homepage` nor `contact` matches a keyword, so both used to fall
        // through to `copycat.word` — "tremo", "audeo".
        expect(probe(generateValue(validator, field, `${field}-input`, NOW) as string)).toBe("https:");
    });
});

describe("generateValue — time-named number columns", () => {
    const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;

    it.each(["createdAt", "updatedAt", "publishedAt", "expiresAt", "eventTimestamp", "startDate", "deletedSince", "validUntil"])(
        "seeds %s as an epoch-ms timestamp inside the recent window",
        (field) => {
            expect.assertions(2);

            const value = generateValue(v.number(), field, `${field}-input`, NOW) as number;

            expect(value).toBeLessThanOrEqual(NOW);
            expect(value).toBeGreaterThanOrEqual(NOW - SIX_MONTHS_MS);
        },
    );

    it.each([
        "rating",
        "latitude",
        "longitude",
        "category",
        "quantity",
        "format",
        "timeout",
        "candidateId",
        "updateCount",
        "seat",
        "responseTime",
        "loadTime",
        "elapsedTime",
    ])("leaves %s as a plain number", (field) => {
        expect.assertions(1);

        // Matching is on the last WORD: `format` ends in "at", `candidateId`
        // contains "date", `timeout` contains "time" — a latitude of 1.78e12
        // is not a latitude.
        expect(generateValue(v.number(), field, `${field}-input`, NOW)).toBeLessThanOrEqual(1000);
    });

    it("lets declared bounds win over the name", () => {
        expect.assertions(1);

        // A schema that says 0..5 means a rating, whatever the column is called.
        const validator = withConstraints(v.number(), { maximum: 5, minimum: 0 });

        expect(generateValue(validator, "createdAt", "bounded-input", NOW)).toBeLessThanOrEqual(5);
    });

    it("is deterministic for the same seed input and clock", () => {
        expect.assertions(1);

        expect(generateValue(v.number(), "createdAt", "same-input", NOW)).toBe(generateValue(v.number(), "createdAt", "same-input", NOW));
    });
});

describe("generateValue — v.from()", () => {
    const fake = {
        "~standard": {
            validate: (value: unknown) => {
                return { value };
            },
            vendor: "fake",
            version: 1 as const,
        },
    };

    it("refuses by name instead of generating a value that fails on insert", () => {
        expect.assertions(2);

        // There is nothing to introspect: the seeder cannot know whether the
        // external schema wants a UUID, an ISO date, or a 20-field object. The
        // generic word fallback would produce a value the very next
        // `ctx.db.insert` rejects, reported as a validation failure on a row
        // nobody wrote by hand.
        expect(() => generateValue(v.from(fake), "mcpServers", "input", NOW)).toThrow(/mcpServers/u);
        // The message must name escapes the seeder actually offers.
        expect(() => generateValue(v.from(fake), "mcpServers", "input", NOW)).toThrow(/overrides|only/u);
    });

    it("refuses through v.optional() too, rather than silently emitting undefined", () => {
        expect.assertions(1);

        expect(() => generateValue(v.optional(v.from(fake)), "mcpServers", "input", NOW)).toThrow(/mcpServers/u);
    });
});
