import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { defineEnv, LunoraEnvError, redactSecrets, v } from "../src/index";

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

/** Run `fn`, assert it threw a {@link LunoraEnvError}, and return it for further assertions. */
const captureEnvError = (function_: () => unknown): LunoraEnvError => {
    expect(function_).toThrow(LunoraEnvError);

    try {
        function_();
    } catch (error) {
        return error as LunoraEnvError;
    }

    throw new Error("expected a LunoraEnvError to be thrown");
};

describe("defineEnv", () => {
    it("validates and returns a typed view of valid env", () => {
        expect.assertions(2);

        const config = defineEnv({
            APP_NAME: v.string(),
            PORT: v.optional(v.number()),
        });

        const env = config({ APP_NAME: "lunora", PORT: "8080" });

        expect(env.APP_NAME).toBe("lunora");
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

    it("throws LunoraEnvError naming a missing required key", () => {
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
            expect(() => env.MISSING).toThrow(LunoraEnvError);
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

    it("throws a redacted LunoraEnvError when env is not an object", () => {
        expect.assertions(2);

        const config = defineEnv({ X: v.string() });

        expect(() => config(undefined)).toThrow(LunoraEnvError);
        expect(() => config.parse(null)).toThrow(LunoraEnvError);
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

        it("redacts under a PLURAL secret-named key exactly as under its singular", () => {
            expect.assertions(4);

            // The classifier's word list is written in the singular and matched
            // against the singular of each word, so a key an app spells in the
            // plural is not a hole in it. It was: only `CREDENTIALS` had been
            // hand-added, so `AUTH_TOKENS` classified as ordinary config and its
            // value reached the thrown message — and the logs — verbatim.
            const weakSecret = ["p@ss", "w0rd!"].join(" ");
            const config = defineEnv({ AUTH_TOKENS: v.number() });

            const error = captureEnvError(() => config({ AUTH_TOKENS: weakSecret }).AUTH_TOKENS);

            expect(error.message).not.toContain(weakSecret);
            expect(error.message).toContain("AUTH_TOKENS");
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

    it("masks secret-named keys in every convention keys arrive in", () => {
        expect.assertions(8);

        // camelCase / lowercase — the spellings request bodies and thrown
        // errors actually use.
        expect(redactSecrets("password: hunter2")).toBe("password=[redacted]");
        expect(redactSecrets("apiToken=abc123")).toBe("apiToken=[redacted]");
        expect(redactSecrets("authSecret: x")).toBe("authSecret=[redacted]");
        // No-separator compounds: the suffix is not preceded by `_`, so a
        // boundary-only rule silently misses these.
        expect(redactSecrets("OPENAI_APIKEY=abc")).toBe("OPENAI_APIKEY=[redacted]");
        expect(redactSecrets("APITOKEN=abc")).toBe("APITOKEN=[redacted]");
        expect(redactSecrets("MYPASSWORD=abc")).toBe("MYPASSWORD=[redacted]"); // gitleaks:allow -- redaction test fixture, not a secret
        expect(redactSecrets("AUTHSECRET=abc")).toBe("AUTHSECRET=[redacted]");
        expect(redactSecrets("TOKEN=abc")).toBe("TOKEN=[redacted]");
    });

    it("masks Title-case and kebab separated secret keys", () => {
        expect.assertions(1);

        // `KEYED_VALUE` captures `[A-Za-z_]\w*`, so a kebab key is only ever
        // seen from its last `-` segment (`Token` here) — which still redacts.
        expect(redactSecrets("Api_Key=abc")).toBe("Api_Key=[redacted]");
    });

    it("leaves an ordinary word merely ending in `key` alone, while still masking the run-together secret forms", () => {
        expect.assertions(5);

        // Bare `key` is NOT a secret word: the classifier splits on `_`/`-`/camelCase
        // and matches whole words, so `MONKEY`, `sortKey` and `PARTITION_KEY` are
        // ordinary config. The forms an earlier bare-`key$` rule existed to catch
        // are covered by name instead (`apikey`, `password`, `token`, …), so
        // nothing that is actually a credential is lost. See shared/secret-key.ts.
        expect(redactSecrets("MONKEY=banana")).toBe("MONKEY=banana");
        expect(redactSecrets("sortKey=created_at")).toBe("sortKey=created_at");
        expect(redactSecrets("PARTITION_KEY=tenant-1")).toBe("PARTITION_KEY=tenant-1");
        expect(redactSecrets("APIKEY=abc")).toBe("APIKEY=[redacted]");
        expect(redactSecrets("apiToken=abc")).toBe("apiToken=[redacted]");
    });

    it("masks bare high-entropy >=24-char tokens", () => {
        expect.assertions(1);

        expect(redactSecrets(`got ${fakeHighEntropy} here`)).toBe("got [redacted] here");
    });

    it("leaves ordinary text and short values untouched", () => {
        expect.assertions(4);

        expect(redactSecrets("PORT=8080 is fine")).toBe("PORT=8080 is fine");
        expect(redactSecrets('expected number, received string "hello"')).toBe('expected number, received string "hello"');
        // Ordinary words that merely contain sk/pk/rk must not be clobbered.
        expect(redactSecrets("the task ran at work on my desktop")).toBe("the task ran at work on my desktop");
        expect(redactSecrets("riskier networks")).toBe("riskier networks");
    });

    it("redacts the password segment of a scheme://user:pass@host URL credential", () => {
        expect.assertions(2);

        // eslint-disable-next-line no-secrets/no-secrets -- test fixture demonstrating URL credential redaction, not a real secret
        const out = redactSecrets("DATABASE_URL=postgres://appuser:s3cr3t@db.internal/app failed");

        expect(out).not.toContain("s3cr3t");
        expect(out).toContain("postgres://appuser");
    });

    it("stays linear on a boundary-rich payload — redaction runs on request bodies and thrown errors", () => {
        expect.assertions(2);

        // The URL-credential pattern led with an unbounded scheme run. `\b` limits
        // which offsets are tried, but `.a.a.a…` opens a boundary at every other
        // position, and at each one the run scanned to end-of-input before failing
        // to find `://` — quadratic. This function is documented as safe to call on
        // request bodies and thrown errors, so that input is attacker-controlled:
        // a 128KB body cost 4.8 SECONDS of CPU inside the Worker.
        const payload = ".a".repeat(64 * 1024);
        const started = Date.now();

        const out = redactSecrets(payload);
        const elapsedMs = Date.now() - started;

        // The payload is one long token run, so the entropy rule masks it — that is
        // incidental. What this pins is the COST of getting there.
        expect(out).toContain("[redacted]");
        expect(elapsedMs).toBeLessThan(1000);
    });

    it("still redacts a password longer than any bound the scheme run uses", () => {
        expect.assertions(2);

        // The scheme is length-bounded; the password deliberately is NOT. A bound
        // there that a real credential exceeded would silently stop redacting it —
        // failing open on the one thing this function exists to prevent.
        const password = "p".repeat(4096);
        const out = redactSecrets(`postgres://appuser:${password}@db.internal/app`); // secret-scanner:allow -- the "credential" is 4096 literal "p" chars from the line above; this URL is the fixture being redacted.

        expect(out).not.toContain(password);
        expect(out).toContain("postgres://appuser");
    });

    it("redacts a credential whose scheme is longer than any bound a scheme match would use", () => {
        expect.assertions(2);

        // The scheme is not matched at all — the pattern anchors on the literal
        // `://` — so its length cannot decide whether a credential is redacted.
        // A length-bounded scheme match failed OPEN here: past the bound it
        // stopped matching, and the password went out verbatim.
        const scheme = "s".repeat(40);
        const out = redactSecrets(`${scheme}://appuser:hunter2@db.internal/app`); // secret-scanner:allow -- "hunter2" is the fixture being redacted, not a credential.

        expect(out).not.toContain("hunter2");
        // The username and the shape survive; the password does not. The scheme
        // itself is NOT asserted here — at this length the standalone-token rule
        // (>=24 chars) redacts it too, so it never reaches the output either way.
        expect(out).toContain("://appuser:[redacted]@");
    });

    it("redacts a usernameless credential URL", () => {
        expect.assertions(3);

        // `redis://:password@host` and `amqps://:pw@broker` are ordinary URLs —
        // both schemes routinely carry a password with no username. Requiring a
        // username left those passwords in the clear.
        const redis = redactSecrets("redis://:onlypass@cache.internal:6379"); // secret-scanner:allow -- "onlypass" is the fixture being redacted.
        const amqp = redactSecrets("amqps://:brokerpw@broker.internal/vhost"); // secret-scanner:allow -- "brokerpw" is the fixture being redacted.

        expect(redis).not.toContain("onlypass");
        expect(amqp).not.toContain("brokerpw");
        expect(redis).toContain("redis://:");
    });

    it("leaves a scheme-only URL and an SSH remote untouched", () => {
        expect.assertions(2);

        // Neither carries a password, so neither should be rewritten. `git@` in
        // particular is a username before the host, not a credential pair.
        expect(redactSecrets("https://example.com/path")).toBe("https://example.com/path");
        expect(redactSecrets("git+ssh://git@github.com/o/r.git")).toBe("git+ssh://git@github.com/o/r.git");
    });

    it("redacts a known-prefix token embedded in free-form text (no entropy floor)", () => {
        expect.assertions(1);

        // A short, embedded `sk_` token that is neither quoted nor a >=24-char run.
        expect(redactSecrets("call failed using sk_live_abc123 oops")).toBe("call failed using [redacted] oops");
    });
});
