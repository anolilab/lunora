import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { CirrusEnvError, defineEnv, redactSecrets, v } from "../src/index";

// Fake credentials are assembled at runtime from harmless fragments so the
// repo's secret scanners (`no-secrets`, `sonarjs/no-hardcoded-secrets`) don't
// flag the literals. They only need to *look* like the prefixes redaction keys
// off; none are real keys. `pad(n)` yields an n-char low-entropy filler run.
const pad = (length: number): string => "x".repeat(length);

const fakeStripeKey = ["sk", "live", pad(24)].join("_");
const fakeGithubToken = ["ghp", pad(28)].join("_");
const fakeAwsKey = ["AKIA", pad(16)].join("");
const fakeSlackToken = ["xoxb", "1234", "5678", pad(12)].join("-");
const fakeHighEntropy = pad(30);
const secretValue = ["hun", "ter", "2"].join("");

/** Run `fn`, assert it threw a {@link CirrusEnvError}, and return it for further assertions. */
const captureEnvError = (function_: () => unknown): CirrusEnvError => {
    expect(function_).toThrow(CirrusEnvError);

    try {
        function_();
    } catch (error) {
        return error as CirrusEnvError;
    }

    throw new Error("expected a CirrusEnvError to be thrown");
};

describe("defineEnv", () => {
    it("validates and returns a typed view of valid env", () => {
        expect.assertions(2);

        const config = defineEnv({
            APP_NAME: v.string(),
            PORT: v.optional(v.number()),
        });

        const env = config({ APP_NAME: "cirrus", PORT: "8080" });

        expect(env.APP_NAME).toBe("cirrus");
        expect(env.PORT).toBe(8080);

        expectTypeOf(env.APP_NAME).toEqualTypeOf<string>();
        expectTypeOf(env.PORT).toEqualTypeOf<number | undefined>();
    });

    it("coerces string env values to number/boolean/bigint", () => {
        expect.assertions(3);

        const config = defineEnv({
            DEBUG: v.boolean(),
            MAX_BYTES: v.bigint(),
            RETRIES: v.number(),
        });

        const env = config({ DEBUG: "true", MAX_BYTES: "9007199254740993", RETRIES: "3" });

        expect(env.RETRIES).toBe(3);
        expect(env.DEBUG).toBe(true);
        expect(env.MAX_BYTES).toBe(9_007_199_254_740_993n);
    });

    it("coerces the documented boolean spellings", () => {
        expect.assertions(6);

        const config = defineEnv({ FLAG: v.boolean() });

        expect(config({ FLAG: "1" }).FLAG).toBe(true);
        expect(config({ FLAG: "yes" }).FLAG).toBe(true);
        expect(config({ FLAG: "ON" }).FLAG).toBe(true);
        expect(config({ FLAG: "0" }).FLAG).toBe(false);
        expect(config({ FLAG: "false" }).FLAG).toBe(false);
        expect(config({ FLAG: "off" }).FLAG).toBe(false);
    });

    it("throws CirrusEnvError naming a missing required key", () => {
        expect.assertions(4);

        const config = defineEnv({ DATABASE_URL: v.string() });

        const error = captureEnvError(() => config({}).DATABASE_URL);

        expect(error.failures).toHaveLength(1);
        expect(error.failures[0]?.key).toBe("DATABASE_URL");
        expect(error.message).toContain("DATABASE_URL");
    });

    it("throws when a coerced value still fails validation, naming the key", () => {
        expect.assertions(2);

        const config = defineEnv({ PORT: v.number() });

        const error = captureEnvError(() => config({ PORT: "not-a-number" }).PORT);

        expect(error.failures[0]?.key).toBe("PORT");
    });

    it("treats absent optional keys as undefined without throwing", () => {
        expect.assertions(1);

        const config = defineEnv({ OPTIONAL_FLAG: v.optional(v.boolean()) });

        expect(config({}).OPTIONAL_FLAG).toBeUndefined();
    });

    describe("lazy per-key validation", () => {
        it("does not validate keys that are never accessed", () => {
            expect.assertions(4);

            const present = v.string();
            const missing = v.string();
            const missingSpy = vi.spyOn(missing, "safeParse");

            const config = defineEnv({ MISSING: missing, PRESENT: present });
            const env = config({ PRESENT: "here" }); // MISSING absent — would throw if validated

            // Accessing PRESENT works and never touches MISSING's validator.
            expect(env.PRESENT).toBe("here");
            expect(missingSpy).not.toHaveBeenCalled();

            // Touching MISSING now throws — proving it was only deferred, not skipped.
            expect(() => env.MISSING).toThrow(CirrusEnvError);
            expect(missingSpy).toHaveBeenCalledTimes(1);
        });

        it("caches a validated key per env identity (parses once)", () => {
            expect.assertions(4);

            const validator = v.string();
            const spy = vi.spyOn(validator, "safeParse");

            const config = defineEnv({ NAME: validator });
            const rawEnv = { NAME: "x" };
            const env = config(rawEnv);

            expect(env.NAME).toBe("x");
            expect(env.NAME).toBe("x");
            expect(config(rawEnv).NAME).toBe("x"); // same identity → same cache

            expect(spy).toHaveBeenCalledTimes(1);
        });
    });

    describe("parse (eager)", () => {
        it("returns a plain object validating every key", () => {
            expect.assertions(1);

            const config = defineEnv({ A: v.string(), B: v.optional(v.number()) });

            expect(config.parse({ A: "a", B: "2" })).toStrictEqual({ A: "a", B: 2 });
        });

        it("collects every failing key, not just the first", () => {
            expect.assertions(4);

            const config = defineEnv({ A: v.string(), B: v.number(), C: v.string() });

            const error = captureEnvError(() => config.parse({ B: "nope" }));
            const keys = error.failures.map((failure) => failure.key);

            expect(keys).toContain("A");
            expect(keys).toContain("B");
            expect(keys).toContain("C");
        });
    });

    it("throws a redacted CirrusEnvError when env is not an object", () => {
        expect.assertions(2);

        const config = defineEnv({ X: v.string() });

        expect(() => config(undefined)).toThrow(CirrusEnvError);
        expect(() => config.parse(null)).toThrow(CirrusEnvError);
    });

    describe("secret redaction in error messages", () => {
        it("never surfaces a prefixed secret value un-redacted", () => {
            expect.assertions(3);

            // STRIPE_KEY's number validator fails on the raw string, putting the
            // secret value into the error message — which must be redacted.
            const config = defineEnv({ STRIPE_KEY: v.number() });

            const error = captureEnvError(() => config({ STRIPE_KEY: fakeStripeKey }).STRIPE_KEY);

            expect(error.message).not.toContain(fakeStripeKey);
            expect(error.message).toContain("STRIPE_KEY");
        });

        it("redacts a high-entropy token value", () => {
            expect.assertions(2);

            const config = defineEnv({ API_TOKEN: v.number() });

            const error = captureEnvError(() => config({ API_TOKEN: fakeHighEntropy }).API_TOKEN);

            expect(error.message).not.toContain(fakeHighEntropy);
        });

        it("redacts a short / special-character secret under a secret-named key (value-shape heuristics can't catch it)", () => {
            expect.assertions(4);

            // "p@ss w0rd!" is short and has a space + punctuation, so it matches no
            // known prefix and isn't a >=24-char token — `redactSecrets` alone would
            // leave it un-redacted. But DATABASE_PASSWORD is secret-named, so the
            // validator-message value must still be scrubbed.
            const weakSecret = ["p@ss", "w0rd!"].join(" ");
            const config = defineEnv({ DATABASE_PASSWORD: v.number() });

            const error = captureEnvError(() => config({ DATABASE_PASSWORD: weakSecret }).DATABASE_PASSWORD);

            expect(error.message).not.toContain(weakSecret);
            expect(error.message).toContain("DATABASE_PASSWORD");
            expect(error.message).toContain("[redacted]");
        });
    });
});

describe("redactSecrets", () => {
    it("masks Stripe/GitHub/AWS/Slack prefixed tokens", () => {
        expect.assertions(4);

        expect(redactSecrets(`value "${fakeStripeKey}"`)).toBe("value [redacted]");
        expect(redactSecrets(`value "${fakeGithubToken}"`)).toContain("[redacted]");
        expect(redactSecrets(`value "${fakeAwsKey}"`)).toContain("[redacted]");
        expect(redactSecrets(`value "${fakeSlackToken}"`)).toContain("[redacted]");
    });

    it("masks the value following a secret-named key", () => {
        expect.assertions(2);

        expect(redactSecrets(`AUTH_SECRET=${secretValue} was rejected`)).toBe("AUTH_SECRET=[redacted] was rejected");
        expect(redactSecrets("DB_PASSWORD: short")).toContain("DB_PASSWORD=[redacted]");
    });

    it("masks bare high-entropy >=24-char tokens", () => {
        expect.assertions(1);

        expect(redactSecrets(`got ${fakeHighEntropy} here`)).toBe("got [redacted] here");
    });

    it("leaves ordinary text and short values untouched", () => {
        expect.assertions(2);

        expect(redactSecrets("PORT=8080 is fine")).toBe("PORT=8080 is fine");
        expect(redactSecrets('expected number, received string "hello"')).toBe('expected number, received string "hello"');
    });
});
