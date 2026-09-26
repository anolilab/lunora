import { describe, expect, it } from "vitest";

import { maskCredentials, SECRET_VALUE_SHAPES } from "../../../shared/credential-redaction";
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
    "privateKey",
    "pwd",
    "refreshToken",
    "salt",
    "sessionId",
    "sid",
    "signature",
    "stripeSecretKey",
    "x-signature",
] as const;

/** A masked value: `<REDACTED>`, or on the log sink the placeholder `standardRules` stamps over it (`<PASSWORD>`, `<APIKEY>`). */
const MASKED = expect.stringMatching(/^<[A-Z]+>$/) as unknown;

/** Keys `standardRules` names exactly. The log sink masks them whole, booleans included; the span sink keeps a boolean. */
const STANDARD_KEYS = ["password", "secret", "token"] as const;

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

    it.each(STANDARD_KEYS)("masks a numeric %s, an OTP or PIN being the usual case", (key) => {
        expect.assertions(1);

        expect([VALUES.array, VALUES.number, VALUES.object, VALUES.string].map((value) => redactField(redact, key, value))).toStrictEqual([
            MASKED,
            MASKED,
            MASKED,
            MASKED,
        ]);
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
        ["Authorization: Basic dXNlcjpwdy1maXh0dXJl", "Authorization: <REDACTED>"], // secret-scanner:allow -- a fabricated credential-shaped fixture exercising the redaction rule, not a secret
        ["Authorization: Bearer fixture.bearer.value", "Authorization: <REDACTED>"], // secret-scanner:allow -- a fabricated credential-shaped fixture exercising the redaction rule, not a secret
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

const CODE_AND_CONCATENATED_KEYS = [
    "accesskey",
    "apiKeys",
    "apikey",
    "authCode",
    "cardNo",
    "hotp",
    "mfaCode",
    "mfa_code",
    "OTP_CODE",
    "otpCode",
    "otp_code",
    "passcode",
    "pinCode",
    "privKey",
    "privatekey",
    "recoveryCode",
    "secretKeys",
    "secret_key_base",
    "secretkey",
    "securityCode",
    "sessionid",
    "totp",
    "twoFactorCode",
    "verificationCode",
] as const;

describe.each(sinks)("%s redaction of one-time codes and concatenated key names", (_sink, redact) => {
    it.each(CODE_AND_CONCATENATED_KEYS)("masks the string and numeric value of %s", (key) => {
        expect.assertions(1);

        expect([redactField(redact, key, "482913-x"), redactField(redact, key, 482_913)]).toStrictEqual([MASKED, MASKED]);
    });

    it.each(["code", "errorCode", "statusCode", "countryCode", "zipCode"])("leaves %s alone, since error and status codes need to show", (key) => {
        expect.assertions(1);

        expect([redactField(redact, key, "E_TIMEOUT"), redactField(redact, key, 504)]).toStrictEqual(["E_TIMEOUT", 504]);
    });
});

describe.each(sinks)("%s redaction keeps app data stored under ambiguous words", (_sink, redact) => {
    it.each([
        ["cards", [{ title: "todo" }]],
        ["card", { done: false, title: "todo" }],
        ["sessions", [{ room: "r1", startedAt: 1 }]],
        ["session", { expiresAt: 1, userId: "u1" }],
        ["pins", [{ lat: 1, lng: 2 }]],
        ["pass", { tier: "gold", zone: "A" }],
    ])("walks, rather than blanks, a %s container", (key, value) => {
        expect.assertions(1);

        expect(redactField(redact, key, value)).toStrictEqual(value);
    });

    it("still masks a scalar under the same words, and credentials nested inside the container", () => {
        expect.assertions(1);

        expect(redact({ card: "4111111111111111", pin: 1234, session: { token: "t-1", userId: "u1" } })).toStrictEqual({
            card: "<REDACTED>",
            pin: "<REDACTED>",
            session: { token: MASKED, userId: "u1" },
        });
    });
});

describe.each(sinks)("%s redaction of more string forms", (_sink, redact) => {
    it.each([
        ["password: correct horse battery", "password: <REDACTED>"],
        ["password: correct horse battery, user=a", "password: <REDACTED>, user=a"],
        [String.raw`payload {\"password\":\"hunter2\",\"user\":\"a\"}`, String.raw`payload {\"password\":\"<REDACTED>\",\"user\":\"a\"}`],
        ["psql --password hunter2 --host db", "psql --password <REDACTED> --host db"],
        ["apikey=k1 passcode=482913", "apikey=<REDACTED> passcode=<REDACTED>"],
    ])("%s", (input, expected) => {
        expect.assertions(1);

        expect(redact(input)).toBe(expected);
    });

    it("masks a PEM private key body, not only its header", () => {
        expect.assertions(2);

        const pem = "-----BEGIN PRIVATE KEY-----\nFIXTUREBODYLINEONE\nSECRETBODYLINE\n-----END PRIVATE KEY-----"; // secret-scanner:allow -- a fabricated credential-shaped fixture exercising the redaction rule, not a secret
        const redacted = redact(`privateKey: ${pem}\ntail`) as string;

        expect(redacted).not.toMatch(/FIXTUREBODYLINEONE|SECRETBODYLINE/);
        expect(redacted).toContain("tail");
    });

    it("masks the credential after a CLI user flag", () => {
        expect.assertions(1);

        // The log sink also masks the host; the credential is what matters here.
        expect(redact("run curl -u user:pw-fixture https://api.example.test/x")).toMatch(/^run curl -u <REDACTED> https:\/\/\S+\/x$/); // secret-scanner:allow -- a fabricated credential-shaped fixture exercising the redaction rule, not a secret
    });

    it.each(["https://user:pa?ss@api.example.test/x", "https://user:pa#ss@api.example.test/x"])(
        "drops the whole authority when a raw ? or # sits inside what looks like userinfo: %s",
        (url) => {
            expect.assertions(1);

            expect(redact(`fetch ${url} failed`)).toBe("fetch https:// failed");
        },
    );

    it("keeps host and path when the only @ is in the query", () => {
        expect.assertions(1);

        expect(redact("GET https://api.example.test:8443/users?email=a@b.test failed")).toMatch(/^GET https:\/\/\S+:8443\/users failed$/);
    });

    it("drops the userinfo of a URL whose password holds an unencoded slash", () => {
        expect.assertions(1);

        expect(redact("db postgres://u:p/ss@db.example.test/app")).not.toMatch(/p\/ss|u:p/);
    });
});

describe.each(sinks)("%s redaction budget", (_sink, redact) => {
    it("redacts 256 strings of 4 KiB in milliseconds, replacing what exceeds the budget with a marker", () => {
        expect.assertions(3);

        const big = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`field${String(index)}`, `note ${"lorem ipsum dolor ".repeat(228)}`]));
        const started = performance.now();
        const redacted = redact(big) as Record<string, string>;
        const elapsed = performance.now() - started;

        expect(elapsed).toBeLessThan(1000);
        expect(redacted["field0"]?.startsWith("note lorem")).toBe(true);
        expect(redacted["field255"]).toBe("[redaction budget exceeded]");
    });
});

describe.each(sinks)("%s redaction of class instances", (_sink, redact) => {
    it("masks credential properties of a class instance", () => {
        expect.assertions(1);

        class Credentials {
            public readonly apiKey = "k-1";

            public readonly user = "u1";
        }

        expect(redact({ credentials: new Credentials(), from: new Credentials() })).toStrictEqual({
            credentials: "<REDACTED>",
            from: { apiKey: MASKED, user: "u1" },
        });
    });

    it("masks what a URL serializes to, not the URL object as-is", () => {
        expect.assertions(1);

        const url = new URL("https://user:pw-fixture@api.example.test/cb?token=fixture-token"); // secret-scanner:allow -- a fabricated credential-shaped fixture exercising the redaction rule, not a secret

        expect(JSON.stringify(redact({ callback: url }))).not.toMatch(/pw-fixture|fixture-token|user:/);
    });

    it("masks the credentials a toJSON method returns", () => {
        expect.assertions(1);

        class Account {
            private readonly user = "u1";

            public toJSON(): Record<string, unknown> {
                return { password: "pw-fixture", user: this.user }; // secret-scanner:allow -- a fabricated credential-shaped fixture exercising the redaction rule, not a secret
            }
        }

        expect(redact({ account: new Account() })).toStrictEqual({ account: { password: MASKED, user: "u1" } });
    });

    it("survives a toJSON that throws or returns itself", () => {
        expect.assertions(2);

        class Throws {
            public readonly apiKey = "k-1";

            public toJSON(): never {
                throw new Error(`cannot serialize ${this.apiKey}`);
            }
        }

        class Self {
            public readonly apiKey = "k-1";

            public toJSON(): this {
                return this;
            }
        }

        expect(JSON.stringify(redact({ value: new Throws() }))).not.toContain("k-1");
        expect(JSON.stringify(redact({ value: new Self() }))).not.toContain("k-1");
    });

    it("keeps a cycle through class instances finite", () => {
        expect.assertions(1);

        class Node {
            public next: Node | undefined;

            public readonly token = "t-1";
        }

        const node = new Node();

        node.next = node;

        expect(() => maskCredentials({ node })).not.toThrow();
    });
});

/**
 * Built, not written out: a credential of the right shape made of an obviously
 * fake filler, so neither the repo's secret scanner nor a reader mistakes a
 * fixture for a real key.
 */
const fake = (prefix: string, length: number, filler = "FAKE0fake9"): string => `${prefix}${filler.repeat(Math.ceil(length / filler.length)).slice(0, length)}`;

const BARE_SECRETS: ReadonlyArray<[string, string]> = [
    ["Stripe secret key (live)", fake("sk_live_", 99)],
    ["Stripe secret key (test)", fake("sk_test_", 24)],
    ["Stripe restricted key", fake("rk_live_", 99)],
    ["Stripe webhook secret", fake("whsec_", 32)],
    ["GitHub personal access token", fake("ghp_", 36)],
    ["GitHub OAuth token", fake("gho_", 36)],
    ["GitHub user-to-server token", fake("ghu_", 36)],
    ["GitHub server-to-server token", fake("ghs_", 36)],
    ["GitHub refresh token", fake("ghr_", 36)],
    ["GitHub fine-grained token", fake("github_pat_", 82)],
    ["GitLab personal access token", fake("glpat-", 20)],
    ["Slack bot token", fake("xoxb-", 50, "1234-FAKE0-")],
    ["Slack user token", fake("xoxp-", 50, "1234-FAKE0-")],
    ["Slack app-level token", fake("xapp-1-", 40, "FAKE0-")],
    ["AWS access key id", fake("AKIA", 16, "FAKE0")],
    ["AWS temporary access key id", fake("ASIA", 16, "FAKE0")],
    ["Google API key", fake("AIza", 35, "FAKE_fake-")],
    ["npm token", fake("npm_", 36)],
    ["Hugging Face token", fake("hf_", 34)],
    ["Shopify access token", fake("shpat_", 32, "deadbeef")],
    ["DigitalOcean token", fake("dop_v1_", 64, "deadbeef")],
    ["OpenAI project key", fake("sk-proj-", 48, "FAKE0_fake-")],
    ["Anthropic key", fake("sk-ant-api03-", 80, "FAKE0_fake-")],
    ["SendGrid key", `${fake("SG.", 22)}.${fake("", 43)}`],
    ["JWT", `${fake("eyJ", 20)}.${fake("eyJ", 30)}.${fake("", 43, "FAKE_fake-")}`],
];

describe.each(sinks)("%s redaction of a bare secret in prose", (_sink, redact) => {
    it.each(BARE_SECRETS)("masks a %s with no key next to it", (_name, secret) => {
        expect.assertions(1);

        expect([redact(`payment failed with ${secret}`), redact(`using token ${secret}, retrying`), redact(`(${secret})`)]).toStrictEqual([
            "payment failed with <REDACTED>",
            "using token <REDACTED>, retrying",
            "(<REDACTED>)",
        ]);
    });

    it("masks every secret in one message and keeps the prose between them", () => {
        expect.assertions(1);

        expect(redact(`tried ${fake("ghp_", 36)} then ${fake("sk_live_", 30)} and gave up`)).toBe("tried <REDACTED> then <REDACTED> and gave up");
    });

    it("still masks a PEM private key in prose, with no key name before it", () => {
        expect.assertions(2);

        // Assembled like the other fixtures, so no line reads as a key.
        const label = "RSA PRIVATE KEY";
        const redacted = redact(`loaded -----BEGIN ${label}-----\n${fake("", 64)}\n-----END ${label}----- ok`) as string;

        expect(redacted).toBe(`loaded -----BEGIN ${label}-----<REDACTED> ok`);
        expect(redacted).not.toContain("FAKE0");
    });
});

describe("span redaction of look-alikes", () => {
    it.each([
        ["a trace id", "trace 4bf92f3577b34da6a3ce929d0e0e4736 span 00f067aa0ba902b7"],
        ["a uuid", "order 3fa85f64-5717-4562-b3fc-2c963f66afa6 shipped"],
        ["a git sha", "deployed da39a3ee5e6b4b0d3255bfef95601890afd80709"],
        ["sk_ inside a word", "the task_live_status and desk_test_fixture flags"],
        ["a prefix without its token", "use sk_live_ keys, ghp_ tokens, xoxb- or AIza in config"],
        ["an identifier that shares a prefix", "npm_package_version hf_hub_cache shopify_shpat_setting ASIA_PACIFIC_REGION_01"],
        ["a normal sentence", "Payment failed: card declined for order 1234 in the Asia region."],
    ])("leaves %s readable", (_name, text) => {
        expect.assertions(1);

        expect(redactSecrets(text)).toBe(text);
    });
});

describe("secret value shapes stay linear", () => {
    const adversarial = [
        "sk_live_x",
        "sk_live_",
        "ghp_",
        "github_pat_",
        "xoxb-",
        "xapp-1-",
        "AKIA",
        "ASIA",
        "AIza-",
        "eyJ.",
        "SG.",
        "sk-ant-",
        "glpat-",
        "dop_v1_",
        "npm_",
        "hf_",
        // One character short of a match, and a prefix repeated inside its own run.
        `ghp_${"a".repeat(29)}`,
        "AIza-".repeat(8),
        "xoxb".repeat(8),
    ]
        .join(" ")
        .repeat(1000)
        .slice(0, 160_000);

    it("scans a 160 KB adversarial string in milliseconds", () => {
        expect.assertions(2);

        const started = performance.now();
        const scanned = adversarial.replaceAll(SECRET_VALUE_SHAPES, "<REDACTED>");
        const elapsed = performance.now() - started;

        expect(adversarial).toHaveLength(160_000);
        expect([elapsed < 250, scanned === adversarial]).toStrictEqual([true, true]);
    });

    it("keeps the 4 KiB cap on the whole redaction", () => {
        expect.assertions(1);

        expect(redactSecrets(adversarial)).toBe(`${adversarial.slice(0, 4096)}…[truncated]`);
    });
});
