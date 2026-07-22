import { describe, expect, it } from "vitest";

import { isSensitiveKey, REDACTED, redactRecord } from "../src/telemetry/redact";

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
