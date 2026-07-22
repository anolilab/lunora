import { describe, expect, it } from "vitest";

import { isSensitiveKey, REDACTED, redactRecord, redactText } from "../src/telemetry/redact";

describe(isSensitiveKey, () => {
    it("flags credential-ish keys, case-insensitively", () => {
        for (const key of [
            "authorization",
            "Authorization",
            "cookie",
            "set-cookie",
            "password",
            "api_key",
            "apiKey",
            "x-api-key",
            "access_token",
            "refresh-token",
            "sessionId",
            "credential",
            "private_key",
            // Previously LEAKED (bounded \btoken\b / camelCase) — must now be caught.
            "auth_token",
            "id_token",
            "authToken",
            "apiToken",
            "idToken",
            "bearerToken",
            "jwtToken",
            "accessKey",
            "clientSecret",
            "encryption_key",
        ]) {
            expect(isSensitiveKey(key)).toBe(true);
        }
    });

    it("leaves ordinary keys alone (incl. non-credential *_key names)", () => {
        for (const key of ["shard_key", "idempotency_key", "user_id", "function_path", "status", "durationMs", "region"]) {
            expect(isSensitiveKey(key)).toBe(false);
        }
    });
});

describe(redactRecord, () => {
    it("scrubs sensitive values but keeps ordinary ones", () => {
        expect(redactRecord({ authorization: "Bearer sk-secret", region: "eu", user_id: "u_1" })).toEqual({
            authorization: REDACTED,
            region: "eu",
            user_id: "u_1",
        });
    });

    it("returns the same reference when nothing is sensitive (no needless copy)", () => {
        const record = { region: "eu", shard_key: "room-9" };

        expect(redactRecord(record)).toBe(record);
    });

    it("passes undefined through", () => {
        expect(redactRecord(undefined)).toBeUndefined();
    });
});

describe(redactText, () => {
    it("scrubs secret-shaped substrings from free text", () => {
        expect(redactText("call with Authorization: Bearer sk_live_abcdefgh12345678")).toContain("Bearer [redacted]");
        expect(redactText("here is my key sk-ABCDEFGHIJKLMNOP1234")).toContain(REDACTED);
        expect(redactText("token=supersecretvalue123 in the log")).toBe(`token=${REDACTED} in the log`);
    });

    it("leaves ordinary prose untouched and passes undefined through", () => {
        const prose = "The user asked about the weather in Berlin.";

        expect(redactText(prose)).toBe(prose);
        expect(redactText(undefined)).toBeUndefined();
    });
});
