import { describe, expect, it } from "vitest";

import { redactArgs, redactSecrets } from "../src/request-log";

/**
 * The redaction contract, as a table: every credential key × every value type,
 * the look-alike keys that must stay readable, and the string forms a handler
 * echoes into an error message. `redactArgs` feeds the request log, Logpush,
 * function metrics and span error messages; `redactSecrets` feeds span, event,
 * link and metric attributes.
 */

type Sink = "log" | "span";

const sinks: ReadonlyArray<[Sink, (value: unknown) => unknown]> = [
    ["log", (value) => redactArgs(value)],
    ["span", (value) => redactSecrets(value)],
];

const VALUES = { array: [1, "x"], boolean: true, number: 12_345_678, object: { a: 1 }, string: "s3cret-v" } as const;

const CREDENTIAL_KEYS = [
    "accessToken",
    "api.key",
    "api_key",
    "clientSecret",
    "connectionString",
    "cookie",
    "DATABASE_URL",
    "dsn",
    "hmac",
    "iban",
    "jwt",
    "newPassword",
    "otp",
    "otpToken",
    "passwordConfirmation",
    "pin",
    "privateKey",
    "pwd",
    "refreshToken",
    "salt",
    "session",
    "sessionId",
    "sid",
    "signature",
    "stripeSecretKey",
    "x-signature",
] as const;

/** Keys `standardRules` names exactly; it masks them whole, booleans included, under its own placeholder. */
const STANDARD_KEYS = { password: "<PASSWORD>", secret: "<SECRET>", token: "<TOKEN>" } as const;

const BENIGN_KEYS = ["code", "passwordChangedAt", "secretary", "shardKey", "tokenizer"] as const;

const COUNT_KEYS = ["maxTokens", "sessionCount", "tokenCount", "tokens", "tokenUsage"] as const;

const redactField = (redact: (value: unknown) => unknown, key: string, value: unknown): unknown => (redact({ [key]: value }) as Record<string, unknown>)[key];

describe.each(sinks)("%s redaction by key", (_sink, redact) => {
    it.each(CREDENTIAL_KEYS)("masks every non-boolean value under %s", (key) => {
        expect.assertions(1);

        expect(Object.fromEntries(Object.entries(VALUES).map(([type, value]) => [type, redactField(redact, key, value)]))).toStrictEqual({
            array: "<REDACTED>",
            boolean: true,
            number: "<REDACTED>",
            object: "<REDACTED>",
            string: "<REDACTED>",
        });
    });

    it.each(Object.entries(STANDARD_KEYS))("masks a numeric %s, an OTP or PIN being the usual case", (key, placeholder) => {
        expect.assertions(1);

        expect(Object.values(VALUES).map((value) => redactField(redact, key, value))).toStrictEqual(Object.values(VALUES).map(() => placeholder));
    });

    it.each(BENIGN_KEYS)("leaves %s alone", (key) => {
        expect.assertions(1);

        expect(Object.values(VALUES).map((value) => redactField(redact, key, value))).toStrictEqual(Object.values(VALUES));
    });

    it.each(COUNT_KEYS)("keeps the numbers and nested objects of a measurement key like %s", (key) => {
        expect.assertions(1);

        expect(Object.fromEntries(Object.entries(VALUES).map(([type, value]) => [type, redactField(redact, key, value)]))).toStrictEqual({
            array: [1, "<REDACTED>"],
            boolean: true,
            number: 12_345_678,
            object: { a: 1 },
            string: "<REDACTED>",
        });
    });
});

describe.each(sinks)("%s redaction of strings", (_sink, redact) => {
    it.each([
        ["Authorization: Basic YWRtaW46aHVudGVyMg==", "Authorization: <REDACTED>"],
        ["Authorization: Bearer abc.def.ghi", "Authorization: <REDACTED>"],
        ["password: hunter2", "password: <REDACTED>"],
        ['login failed {"password":"hunter2","user":"a"}', 'login failed {"password":"<REDACTED>","user":"a"}'],
        // eslint-disable-next-line no-secrets/no-secrets -- a fabricated credential-bearing fixture, not a secret
        ["client_secret='abc def' next", "client_secret='<REDACTED>' next"],
        ["pwd=x1 pass=x2 auth=x3 session=x4 sig=x5", "pwd=<REDACTED> pass=<REDACTED> auth=<REDACTED> session=<REDACTED> sig=<REDACTED>"],
        ["Error: token=abc maxTokens=1024", "Error: token=<REDACTED> maxTokens=1024"],
    ])("%s", (input, expected) => {
        expect.assertions(1);

        expect(redact(input)).toBe(expected);
    });

    it("drops every URL's query, whatever its parameters are called", () => {
        expect.assertions(2);

        // eslint-disable-next-line no-secrets/no-secrets -- a fabricated credential-bearing fixture, not a secret
        const redacted = redact("callback https://api.example.test/cb?access_token=abc123&sig=deadbeef&X-Amz-Signature=cafe#frag") as string;

        expect(redacted).not.toMatch(/abc123|deadbeef|cafe|frag/);
        expect(redacted.endsWith("/cb")).toBe(true);
    });

    it("drops a connection string's userinfo and query", () => {
        expect.assertions(1);

        // The log sink also masks the host (`<DOMAIN>`); the port and path stay either way.
        // eslint-disable-next-line no-secrets/no-secrets -- a fabricated credential-bearing fixture, not a secret
        expect(redact("db postgres://admin:p%40ss!word@db.example.test:5432/app?sslmode=require")).toMatch(/^db postgres:\/\/[^:@]+:5432\/app$/);
    });

    it("does not mask prose around a URL", () => {
        expect.assertions(1);

        expect(redact("invalid token for https://api.example.test/cb?x=1")).toMatch(/^invalid token for https:\/\/\S+\/cb$/);
    });

    it("truncates an oversized string before running any pattern", () => {
        expect.assertions(1);

        expect(redact("x".repeat(200_000))).toBe(`${"x".repeat(4096)}…[truncated]`);
    });
});

describe("span redaction keeps ids", () => {
    it("leaves a 32-hex trace id, an undashed uuid and a git sha readable", () => {
        expect.assertions(1);

        const attributes = {
            commit: "356a192b7913b04c54574d18c28d46e6395428ab",
            "order.id": "3f2a1c7e9b1d4c2a8e2f1a2b3c4d5e6f",
            traceId: "0af7651916cd43dd8448eb211c80319c",
        };

        expect(redactSecrets(attributes)).toStrictEqual(attributes);
    });
});
