import { describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret } from "../src/secrets/crypto";

const KEY = "a".repeat(64);

describe("secret crypto", () => {
    it("round-trips a value and stores only ciphertext", async () => {
        const encrypted = await encryptSecret(KEY, "s3cr3t-value");

        expect(encrypted.ciphertext).not.toContain("s3cr3t");
        await expect(decryptSecret(KEY, encrypted)).resolves.toBe("s3cr3t-value");
    });

    it("uses a fresh IV per encryption", async () => {
        const a = await encryptSecret(KEY, "same");
        const b = await encryptSecret(KEY, "same");

        expect(a.iv).not.toBe(b.iv);
        expect(a.ciphertext).not.toBe(b.ciphertext);
    });

    it("fails to decrypt under a different key", async () => {
        const encrypted = await encryptSecret(KEY, "hello");

        await expect(decryptSecret("b".repeat(64), encrypted)).rejects.toThrow();
    });

    it("rejects a malformed master key", async () => {
        await expect(encryptSecret("not-32-bytes", "x")).rejects.toThrow(/32 bytes/u);
    });
});
