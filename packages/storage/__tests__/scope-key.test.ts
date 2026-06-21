import { describe, expect, it } from "vitest";

import { scopeKey } from "../src/create-storage";

describe("scopeKey", () => {
    it("composes a per-tenant prefix and key", () => {
        expect.assertions(1);

        expect(scopeKey("users/alice", "avatar.png")).toBe("users/alice/avatar.png");
    });

    it("trims a single trailing slash off the prefix before joining", () => {
        expect.assertions(1);

        expect(scopeKey("users/alice/", "avatar.png")).toBe("users/alice/avatar.png");
    });

    it("rejects a `..` path component in the caller-supplied key (IDOR guard)", () => {
        expect.assertions(1);

        // The whole point of scopeKey is that a client key can't escape its tenant prefix.
        expect(() => scopeKey("users/alice", "../bob/secret")).toThrow(/path component/u);
    });

    it("rejects a `..` path component in the prefix", () => {
        expect.assertions(1);

        expect(() => scopeKey("users/../admin", "k")).toThrow(/path component/u);
    });

    it("rejects a NUL byte in either half", () => {
        expect.assertions(2);

        expect(() => scopeKey("users/alice", "a\0b")).toThrow(/NUL byte/u);
        expect(() => scopeKey("users\0alice", "k")).toThrow(/NUL byte/u);
    });

    it("rejects an empty prefix or key", () => {
        expect.assertions(2);

        expect(() => scopeKey("", "k")).toThrow(/non-empty/u);
        expect(() => scopeKey("users/alice", "")).toThrow(/non-empty/u);
    });

    it("rejects a key that starts with `/` (would escape the prefix root)", () => {
        expect.assertions(1);

        expect(() => scopeKey("users/alice", "/etc/passwd")).toThrow(/must not start with/u); // gitleaks:allow -- path-traversal test fixture, not a secret
    });

    it("rejects a composed key beyond R2's 1024-byte ceiling", () => {
        expect.assertions(1);

        const longKey = "a".repeat(1020);

        expect(() => scopeKey("users/alice", longKey)).toThrow(/scoped key exceeds/u);
    });
});
