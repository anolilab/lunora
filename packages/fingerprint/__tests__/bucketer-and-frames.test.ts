import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { fingerprint, fingerprintError, fingerprintLog, messageBucketFor, normalizeMessage, sha256Hex } from "../src/index";
import { parseFrames } from "../src/superlog";

const nodeSha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

describe("sha256Hex parity with node:crypto", () => {
    // The portable backend must be byte-for-byte identical to the node:crypto
    // implementation upstream superlog uses — over every padding boundary and
    // multi-byte UTF-8, not just the published NIST vectors.
    it("matches node:crypto across padding boundaries and UTF-8 inputs", () => {
        expect.assertions(12);

        const inputs = [
            "",
            "a",
            "lunora::messages:list::user <n> not found",
            "x".repeat(55), // last single-block length
            "x".repeat(56), // length field spills into a second block
            "x".repeat(63),
            "x".repeat(64), // exact block
            "x".repeat(65),
            "x".repeat(1000),
            "héllo — 世界 🚀", // multi-byte UTF-8 through TextEncoder
            "\u0000\u0001\u0002",
            "Error::boom::foo@src/x.ts",
        ];

        for (const input of inputs) {
            expect(sha256Hex(input), `mismatch for ${JSON.stringify(input.slice(0, 20))}…`).toBe(nodeSha256(input));
        }
    });
});

describe("messageBucketFor noise stripping", () => {
    it("strips each noise class to its token", () => {
        expect.assertions(8);

        expect(messageBucketFor("GET https://api.example.com/v1/users?id=17 failed")).toBe("get <url> failed");
        expect(messageBucketFor("mail to admin@example.com bounced")).toBe("mail to <email> bounced");
        expect(messageBucketFor("user 123e4567-e89b-12d3-a456-426614174000 missing")).toBe("user <uuid> missing");
        expect(messageBucketFor("failed at 2024-01-02T03:04:05.123Z retrying")).toBe("failed at <ts> retrying");
        expect(messageBucketFor("connect 10.0.0.1:5432 refused")).toBe("connect <ip> refused");
        expect(messageBucketFor("segfault near 0xDEADBEEF")).toBe("segfault near <hex>");
        expect(messageBucketFor(`session ${"blob".repeat(6)} expired`)).toBe("session <id> expired");
        expect(messageBucketFor("row 42 of 1000 rejected")).toBe("row <n> of <n> rejected");
    });

    it("collapses whitespace and lowercases", () => {
        expect.assertions(1);

        expect(messageBucketFor("  Boom\n\t Happened   Twice ")).toBe("boom happened twice");
    });

    it("returns an empty bucket for empty-ish input", () => {
        expect.assertions(3);

        expect(messageBucketFor("")).toBe("");
        expect(messageBucketFor(null)).toBe("");
        expect(messageBucketFor(undefined)).toBe("");
    });

    it("caps the bucket at 160 chars", () => {
        expect.assertions(1);

        expect(messageBucketFor("word ".repeat(100))).toHaveLength(160);
    });

    it("clamps raw input before the regexes run (100KB message is safe and stable)", () => {
        expect.assertions(1);

        // The bucketer only ever sees the first 1024 chars, so a huge (possibly
        // adversarial) message buckets exactly like its 1024-char prefix.
        const huge = `${"lorem ipsum dolor sit amet ".repeat(4000)}unique-trailing-difference`;

        expect(messageBucketFor(huge)).toBe(messageBucketFor(huge.slice(0, 1024)));
    });

    it("unwraps an Anthropic-style error envelope before bucketing", () => {
        expect.assertions(2);

        const raw =
            '400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 4096 exceeds model limit"},"request_id":"req_011CRJxyz"}';

        // The per-request request_id must not leak into the bucket — only the
        // inner human-readable message is hashed.
        expect(messageBucketFor(raw)).toBe("max_tokens: <n> exceeds model limit");
        // Escaped quotes inside the envelope are unescaped faithfully.
        expect(messageBucketFor(String.raw`500 {"message":"say \"hi\" now"}`)).toBe('say "hi" now');
    });

    it("two occurrences differing only by noise share one bucket", () => {
        expect.assertions(1);

        const a = messageBucketFor("upload 9f1c2d3e-aaaa-bbbb-cccc-000000000001 from 10.1.2.3:443 failed with 503 at 2025-01-01T00:00:00Z");
        const b = messageBucketFor("upload 11111111-2222-3333-4444-555555555555 from 192.168.0.9:8443 failed with 502 at 2025-06-30T12:34:56Z");

        expect(a).toBe(b);
    });
});

describe("normalizeMessage (log-body normalizer)", () => {
    it("replaces quoted strings and long hex runs", () => {
        expect.assertions(3);

        expect(normalizeMessage('table "users" is locked')).toBe("table <str> is locked");
        expect(normalizeMessage("value 'abc' rejected")).toBe("value <str> rejected");
        expect(normalizeMessage("commit deadbeefdeadbeefdeadbeef failed")).toBe("commit <hex> failed");
    });
});

describe("fingerprintError determinism", () => {
    it("is stable across calls for the same input", () => {
        expect.assertions(2);

        const a = fingerprintError({ functionPath: "messages:list", message: "boom" });
        const b = fingerprintError({ functionPath: "messages:list", message: "boom" });

        expect(a.hash).toBe(b.hash);
        expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it("never folds the code into the hash — it is display metadata only", () => {
        expect.assertions(3);

        const withA = fingerprintError({ code: "NOT_FOUND", functionPath: "messages:list", message: "gone" });
        const withB = fingerprintError({ code: "INTERNAL", functionPath: "messages:list", message: "gone" });
        const without = fingerprintError({ functionPath: "messages:list", message: "gone" });

        expect(withA.hash).toBe(withB.hash);
        expect(withA.hash).toBe(without.hash);
        expect(withA.code).toBe("NOT_FOUND");
    });

    it("hashes exactly sha256('lunora::' + culprit + '::' + bucket) truncated to 16", () => {
        expect.assertions(1);

        const fp = fingerprintError({ functionPath: "messages:list", message: "User 12345 not found" });
        const expected = nodeSha256(`lunora::messages:list::${messageBucketFor("User 12345 not found")}`).slice(0, 16);

        expect(fp.hash).toBe(expected);
    });

    it("exposes the bucket it grouped on for inspection", () => {
        expect.assertions(1);

        expect(fingerprintError({ functionPath: "a:b", message: "User 12345 not found" }).bucket).toBe("user <n> not found");
    });

    it("defaults the culprit to 'unknown' for an empty function path", () => {
        expect.assertions(2);

        const a = fingerprintError({ functionPath: "", message: "boom" });

        expect(a.culprit).toBe("unknown");
        expect(a.hash).toBe(fingerprintError({ functionPath: "unknown", message: "boom" }).hash);
    });
});

describe("fingerprint stack-frame grouping", () => {
    it("prefers user frames — a node_modules wrapper frame does not change the group", () => {
        expect.assertions(1);

        const direct = fingerprint({
            message: "boom",
            stacktrace: "    at handler (/repo/packages/api/src/handler.ts:5:3)",
            type: "Error",
        });
        const wrapped = fingerprint({
            message: "boom",
            stacktrace: ["    at wrap (/repo/node_modules/express/lib/router.js:10:5)", "    at handler (/repo/packages/api/src/handler.ts:5:3)"].join("\n"),
            type: "Error",
        });

        expect(wrapped.hash).toBe(direct.hash);
    });

    it("falls back to vendor frames when no user frame exists", () => {
        expect.assertions(2);

        const fp = fingerprint({ message: "boom", stacktrace: "    at wrap (/repo/node_modules/express/lib/router.js:10:5)", type: "Error" });

        // The path normalizer trims to the earliest repo-ish segment (`lib/`).
        expect(fp.topFrame).toBe("wrap@lib/router.js");
        expect(fp.normalizedFrames).toHaveLength(1);
    });

    it("normalizes bundler/file-url prefixes down to the repo-relative path", () => {
        expect.assertions(3);

        expect(fingerprint({ stacktrace: "    at fn (file:///srv/worker/src/foo.ts:1:1)", type: "Error" }).topFrame).toBe("fn@src/foo.ts");
        expect(fingerprint({ stacktrace: "    at fn (webpack-internal:///./src/x.ts:1:1)", type: "Error" }).topFrame).toBe("fn@src/x.ts");
        // A bare (function-less) frame keeps just the normalized path.
        expect(fingerprint({ stacktrace: "    at /srv/worker/packages/do/src/y.ts:3:1", type: "Error" }).topFrame).toBe("packages/do/src/y.ts");
    });

    it("only the top five user frames participate in the hash", () => {
        expect.assertions(1);

        const frames = (tail: string): string =>
            [
                "    at f1 (/r/src/a.ts:1:1)",
                "    at f2 (/r/src/b.ts:1:1)",
                "    at f3 (/r/src/c.ts:1:1)",
                "    at f4 (/r/src/d.ts:1:1)",
                "    at f5 (/r/src/e.ts:1:1)",
                `    at ${tail} (/r/src/z.ts:1:1)`,
            ].join("\n");

        expect(fingerprint({ stacktrace: frames("sixthA"), type: "Error" }).hash).toBe(fingerprint({ stacktrace: frames("sixthB"), type: "Error" }).hash);
    });

    it("defaults an empty exception type to 'Error'", () => {
        expect.assertions(1);

        expect(fingerprint({ stacktrace: "", type: "" }).exceptionType).toBe("Error");
    });
});

describe("fingerprintLog routing", () => {
    it("delegates to the stack-aware fingerprint when a stacktrace exists", () => {
        expect.assertions(1);

        const stack = "    at handler (/repo/src/handler.ts:5:3)";
        const viaLog = fingerprintLog({ body: "ignored", exceptionType: "TypeError", service: "api", severity: "ERROR", stacktrace: stack });
        const direct = fingerprint({ stacktrace: stack, type: "TypeError" });

        expect(viaLog.hash).toBe(direct.hash);
    });

    it("groups stackless logs by service + type + normalized body", () => {
        expect.assertions(3);

        const a = fingerprintLog({ body: "job 12 failed", service: "worker", severity: "ERROR", stacktrace: null });
        const b = fingerprintLog({ body: "job 99 failed", service: "worker", severity: "ERROR", stacktrace: null });
        const otherService = fingerprintLog({ body: "job 12 failed", service: "mailer", severity: "ERROR", stacktrace: null });

        expect(a.hash).toBe(b.hash); // ids normalize away
        expect(a.hash).not.toBe(otherService.hash); // service is part of the group
        expect(a.normalizedFrames).toStrictEqual([]);
    });

    it("falls back to severity for the type and 'unknown' for the service", () => {
        expect.assertions(2);

        const fp = fingerprintLog({ body: "boom", service: "", severity: "FATAL", stacktrace: undefined });

        expect(fp.exceptionType).toBe("FATAL");
        expect(fp.hash).toBe(fingerprintLog({ body: "boom", service: "unknown", severity: "FATAL", stacktrace: null }).hash);
    });
});

describe("stacktrace parser clamps", () => {
    it("parses a pathological paren-heavy line in bounded time", () => {
        expect.assertions(2);

        // O(k * len) before the clamps: every whitespace-preceded "(" sliced the
        // rest of the line. Must return (frame or not) without stalling.
        const line = `at ${"x (".repeat(20_000)}f.js:1:1)`;
        const start = performance.now();
        const frames = parseFrames(line);
        const elapsed = performance.now() - start;

        expect(Array.isArray(frames)).toBe(true);
        expect(elapsed).toBeLessThan(200);
    });

    it("caps a 100-line stack at STACK_FRAMES_MAX frames", () => {
        expect.assertions(1);

        const stack = Array.from({ length: 100 }, (_, index) => `    at fn${String(index)} (src/handler.ts:${String(index + 1)}:1)`).join("\n");

        expect(parseFrames(stack)).toHaveLength(64);
    });

    it("keeps the fingerprint of a well-formed stack byte-identical", () => {
        expect.assertions(2);

        const fp = fingerprint({
            stacktrace: "    at handler (/repo/packages/api/src/handler.ts:5:3)",
            type: "TypeError",
        });

        expect(fp.topFrame).toBe("handler@packages/api/src/handler.ts");
        expect(fp.hash).toBe("d1886ae5325dfff1");
    });
});
