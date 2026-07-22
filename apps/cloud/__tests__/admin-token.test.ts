import { describe, expect, it } from "vitest";

import { resolveAdminToken, sealAdminToken } from "../src/deploy/admin-token";

// 32-byte (64 hex char) AES-256 key.
const KEY = "0".repeat(64);
const OTHER_KEY = "a".repeat(64);

describe("admin token at-rest sealing", () => {
    it("seals to ciphertext + IV when a master key is present (never plaintext)", async () => {
        const sealed = await sealAdminToken("adm_secret", KEY);

        expect(sealed.adminToken).toBeUndefined();
        expect(sealed.adminTokenCiphertext).toBeTypeOf("string");
        expect(sealed.adminTokenIv).toBeTypeOf("string");
        // The plaintext must not appear anywhere in the stored form.
        expect(JSON.stringify(sealed)).not.toContain("adm_secret");
    });

    it("round-trips: a sealed token decrypts back to the original", async () => {
        const sealed = await sealAdminToken("adm_secret", KEY);

        await expect(resolveAdminToken(sealed, KEY)).resolves.toBe("adm_secret");
    });

    it("uses a fresh IV per seal (same token seals to different ciphertext)", async () => {
        const a = await sealAdminToken("adm_secret", KEY);
        const b = await sealAdminToken("adm_secret", KEY);

        expect(a.adminTokenCiphertext).not.toBe(b.adminTokenCiphertext);
        expect(a.adminTokenIv).not.toBe(b.adminTokenIv);
    });

    it("falls back to plaintext storage when no master key is configured (dev)", async () => {
        const sealed = await sealAdminToken("adm_secret");

        expect(sealed).toStrictEqual({ adminToken: "adm_secret" });
        await expect(resolveAdminToken(sealed)).resolves.toBe("adm_secret");
    });

    it("returns undefined for a sealed token when the key is missing (never leaks ciphertext)", async () => {
        const sealed = await sealAdminToken("adm_secret", KEY);

        await expect(resolveAdminToken(sealed, undefined)).resolves.toBeUndefined();
    });

    it("fails to decrypt a sealed token under the wrong key", async () => {
        const sealed = await sealAdminToken("adm_secret", KEY);

        await expect(resolveAdminToken(sealed, OTHER_KEY)).rejects.toThrow();
    });

    it("resolves nothing for an empty row", async () => {
        await expect(resolveAdminToken({}, KEY)).resolves.toBeUndefined();
    });
});
