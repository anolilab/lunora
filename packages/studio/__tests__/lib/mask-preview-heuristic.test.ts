import { describe, expect, it } from "vitest";

import type { MaskStrategy } from "../../src/lib/admin";
import { isSensitiveColumnName, mergeSensitiveColumns } from "../../src/lib/mask-preview";

describe("isSensitiveColumnName", () => {
    it.each([
        "password",
        "passwd",
        "pwd",
        "secret",
        "token",
        "api_key",
        "apiKey",
        "API_KEY",
        "access_token",
        "accessToken",
        "refresh_token",
        "private_key",
        "client_secret",
        "ssn",
        "credit_card",
        "card_number",
        "cvv",
        // prefixed / suffixed variants split on word boundaries
        "user_password",
        "userPassword",
        "stripe_api_key",
        "hashedPassword",
    ])("matches the sensitive name %s", (name) => {
        expect.assertions(1);

        expect(isSensitiveColumnName(name)).toBe(true);
    });

    it.each([
        "id",
        "email",
        "name",
        "created_at",
        "updated_at",
        "title",
        "description",
        // near-misses that must NOT match (no whole-word secret token)
        "secretary",
        "tokenizer",
        "passport",
        "discreet",
        "address",
        "tokens_used",
    ])("does not match the ordinary name %s", (name) => {
        expect.assertions(1);

        expect(isSensitiveColumnName(name)).toBe(false);
    });

    it("matches case-insensitively", () => {
        expect.assertions(2);

        expect(isSensitiveColumnName("PASSWORD")).toBe(true);
        expect(isSensitiveColumnName("Secret")).toBe(true);
    });
});

describe("mergeSensitiveColumns", () => {
    it("adds a redact strategy for heuristic-matched columns not already covered", () => {
        expect.assertions(3);

        const explicit = new Map<string, MaskStrategy>([["email", "hash"]]);
        const merged = mergeSensitiveColumns(explicit, ["id", "email", "password", "api_key"]);

        expect(merged.get("password")).toBe("redact");
        expect(merged.get("api_key")).toBe("redact");
        // non-sensitive column stays uncovered
        expect(merged.has("id")).toBe(false);
    });

    it("keeps an explicit policy over the heuristic for the same column", () => {
        expect.assertions(1);

        // `secret` is heuristic-sensitive, but an explicit hash policy must win.
        const explicit = new Map<string, MaskStrategy>([["secret", "hash"]]);
        const merged = mergeSensitiveColumns(explicit, ["secret"]);

        expect(merged.get("secret")).toBe("hash");
    });

    it("returns the explicit map unchanged when no column looks sensitive", () => {
        expect.assertions(1);

        const explicit = new Map<string, MaskStrategy>([["email", "hash"]]);
        const merged = mergeSensitiveColumns(explicit, ["id", "email", "name"]);

        expect(merged).toBe(explicit);
    });
});
