import { describe, expect, it } from "vitest";

import { sessionPresets, validateSessionPolicy } from "../src/session";

/**
 * `sessionPresets` and `validateSessionPolicy` are the Lunora-friendly surface
 * over better-auth's `session` option. These tests pin the preset shapes and
 * the validation guards; the actual rotation behavior is better-auth's domain
 * and is covered end-to-end in the playground suite.
 */
describe("sessionPresets", () => {
    it.each(["rolling", "strict", "longLived"] as const)("exposes `%s` with finite, positive durations", (name) => {
        expect.assertions(3);

        const preset = sessionPresets[name];

        expect(preset.expiresIn).toBeGreaterThan(0);
        expect(preset.updateAge).toBeGreaterThan(0);
        expect(preset.freshAge).toBeGreaterThan(0);
    });

    it("orders presets from strictest to most relaxed expiry", () => {
        expect.assertions(2);

        expect(sessionPresets.strict.expiresIn).toBeLessThan(sessionPresets.rolling.expiresIn ?? 0);
        expect(sessionPresets.rolling.expiresIn).toBeLessThan(sessionPresets.longLived.expiresIn ?? 0);
    });

    it("enables a 60s cookie cache on `rolling` and `longLived`", () => {
        expect.assertions(4);

        expect(sessionPresets.rolling.cookieCache?.enabled).toBe(true);
        expect(sessionPresets.rolling.cookieCache?.maxAge).toBe(60);
        expect(sessionPresets.longLived.cookieCache?.enabled).toBe(true);
        expect(sessionPresets.longLived.cookieCache?.maxAge).toBe(60);
    });

    it("disables the cookie cache on `strict` (fast revocation)", () => {
        expect.assertions(1);

        expect(sessionPresets.strict.cookieCache?.enabled).toBe(false);
    });
});

describe("validateSessionPolicy", () => {
    it("returns a valid policy unchanged", () => {
        expect.assertions(1);

        const policy = { expiresIn: 3600, freshAge: 300, updateAge: 60 };

        expect(validateSessionPolicy(policy)).toBe(policy);
    });

    it("accepts an empty policy and policies with omitted durations", () => {
        expect.assertions(2);

        expect(() => validateSessionPolicy({})).not.toThrow();
        expect(() => validateSessionPolicy({ disableSessionRefresh: true })).not.toThrow();
    });

    it("accepts a zero duration (rotate-every-use / always-fresh)", () => {
        expect.assertions(1);

        expect(() => validateSessionPolicy({ updateAge: 0 })).not.toThrow();
    });

    it.each(["expiresIn", "updateAge", "freshAge"] as const)("rejects a negative `%s`", (field) => {
        expect.assertions(1);

        expect(() => validateSessionPolicy({ [field]: -1 })).toThrow(/non-negative/i);
    });

    it("rejects a NaN duration", () => {
        expect.assertions(1);

        expect(() => validateSessionPolicy({ expiresIn: Number.NaN })).toThrow(/finite/i);
    });
});
