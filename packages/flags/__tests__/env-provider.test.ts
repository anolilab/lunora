import { afterEach, describe, expect, it, vi } from "vitest";

import { createFlags, resetFlags } from "../src/flags";
import { envProvider } from "../src/providers/env";

describe("envProvider", () => {
    afterEach(async () => {
        await resetFlags();
        vi.restoreAllMocks();
    });

    describe("envProvider — key derivation", () => {
        it("maps a kebab key to FLAG_UPPER_SNAKE by default", async () => {
            expect.assertions(2);

            const provider = envProvider()({ FLAG_DARK_MODE: "true" });

            const details = await provider.resolveBooleanEvaluation("dark-mode", false, {}, console);

            expect(details.value).toBe(true);
            expect(details.reason).toBe("STATIC");
        });

        it("honours a custom prefix", async () => {
            expect.assertions(1);

            const provider = envProvider({ prefix: "FEATURE_" })({ FEATURE_DARK_MODE: "true" });

            await expect(provider.resolveBooleanEvaluation("dark-mode", false, {}, console)).resolves.toMatchObject({ value: true });
        });

        it("honours a custom name mapper", async () => {
            expect.assertions(1);

            const provider = envProvider({ name: (key) => `X-${key}` })({ "X-dark-mode": "true" });

            await expect(provider.resolveBooleanEvaluation("dark-mode", false, {}, console)).resolves.toMatchObject({ value: true });
        });
    });

    describe("envProvider — boolean coercion", () => {
        it.each([
            ["true", true],
            ["1", true],
            ["on", true],
            ["YES", true],
            ["false", false],
            ["0", false],
            ["off", false],
            ["No", false],
        ])("coerces %s → %s", async (raw, expected) => {
            expect.assertions(1);

            const provider = envProvider()({ FLAG_X: raw });

            await expect(provider.resolveBooleanEvaluation("x", !expected, {}, console)).resolves.toMatchObject({ reason: "STATIC", value: expected });
        });

        it("parse-errors on a non-boolean string, returning the default", async () => {
            expect.assertions(3);

            const provider = envProvider()({ FLAG_X: "maybe" });

            const details = await provider.resolveBooleanEvaluation("x", false, {}, console);

            expect(details.value).toBe(false);
            expect(details.reason).toBe("ERROR");
            expect(details.errorCode).toBe("PARSE_ERROR");
        });
    });

    describe("envProvider — number / string / object coercion", () => {
        it("coerces a numeric string", async () => {
            expect.assertions(1);

            const provider = envProvider()({ FLAG_PAGE_SIZE: "25" });

            await expect(provider.resolveNumberEvaluation("page-size", 10, {}, console)).resolves.toMatchObject({ value: 25 });
        });

        it("parse-errors on a non-numeric string", async () => {
            expect.assertions(1);

            const provider = envProvider()({ FLAG_PAGE_SIZE: "lots" });

            await expect(provider.resolveNumberEvaluation("page-size", 10, {}, console)).resolves.toMatchObject({ errorCode: "PARSE_ERROR", value: 10 });
        });

        it("returns the raw string value", async () => {
            expect.assertions(1);

            const provider = envProvider()({ FLAG_HERO: "variant-b" });

            await expect(provider.resolveStringEvaluation("hero", "control", {}, console)).resolves.toMatchObject({ value: "variant-b" });
        });

        it("parses a JSON object value", async () => {
            expect.assertions(1);

            const provider = envProvider()({ FLAG_ROLLOUT: '{"percent":10}' });

            await expect(provider.resolveObjectEvaluation("rollout", {}, {}, console)).resolves.toMatchObject({ value: { percent: 10 } });
        });

        it("parse-errors on invalid JSON", async () => {
            expect.assertions(1);

            const provider = envProvider()({ FLAG_ROLLOUT: "{not json}" });

            await expect(provider.resolveObjectEvaluation("rollout", { fallback: true }, {}, console)).resolves.toMatchObject({
                errorCode: "PARSE_ERROR",
                value: { fallback: true },
            });
        });
    });

    describe("envProvider — missing values & non-string env", () => {
        it("falls back to the default with reason DEFAULT when the var is absent", async () => {
            expect.assertions(1);

            const provider = envProvider()({});

            await expect(provider.resolveStringEvaluation("hero", "control", {}, console)).resolves.toMatchObject({ reason: "DEFAULT", value: "control" });
        });

        it("treats null as absent", async () => {
            expect.assertions(1);

            const provider = envProvider()({ FLAG_HERO: null });

            await expect(provider.resolveStringEvaluation("hero", "control", {}, console)).resolves.toMatchObject({ reason: "DEFAULT", value: "control" });
        });

        it("stringifies a non-string env value (e.g. a boolean var)", async () => {
            expect.assertions(1);

            const provider = envProvider()({ FLAG_DARK_MODE: true });

            await expect(provider.resolveBooleanEvaluation("dark-mode", false, {}, console)).resolves.toMatchObject({ value: true });
        });
    });

    describe("envProvider — end-to-end through createFlags", () => {
        it("reads flags from the env the factory is bound with", async () => {
            expect.assertions(3);

            // Codegen wraps a FlagsProviderFactory as `() => factory(env)`; mirror that.
            const factory = envProvider();
            const env = { FLAG_DARK_MODE: "true", FLAG_PAGE_SIZE: "25" };
            const flags = createFlags({ provider: () => factory(env) });

            await expect(flags.boolean("dark-mode", false)).resolves.toBe(true);
            await expect(flags.number("page-size", 10)).resolves.toBe(25);
            await expect(flags.string("missing", "fallback")).resolves.toBe("fallback");
        });
    });
});
