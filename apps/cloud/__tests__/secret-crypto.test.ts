import { describe, expect, it } from "vitest";

import { store } from "../lunora/secrets";
import { decryptSecret, encryptSecret } from "../src/secrets/crypto";
import { decryptSecrets, openSecret, sealSecret, SECRET_CIPHER_VERSION, secretsForKind } from "../src/secrets/select";
import { makeCtx, owner } from "./_helpers/fake-ctx";

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

        // WebCrypto rejects with an implementation-defined message; assert the type.
        await expect(decryptSecret("b".repeat(64), encrypted)).rejects.toThrow(Error);
    });

    it("rejects a malformed master key", async () => {
        await expect(encryptSecret("not-32-bytes", "x")).rejects.toThrow(/32 bytes/u);
    });

    it("rejects a 64-character master key that is not hex", async () => {
        await expect(encryptSecret("z".repeat(64), "x")).rejects.toThrow(/must be hex/u);
    });
});

describe("secret binding", () => {
    const orgA = { organizationId: "org_a", projectId: "proj_a" };
    const orgB = { organizationId: "org_b", projectId: "proj_b" };

    it("fails to decrypt under different additional data", async () => {
        const encrypted = await encryptSecret(KEY, "hello", "a");

        await expect(decryptSecret(KEY, encrypted, "a")).resolves.toBe("hello");
        await expect(decryptSecret(KEY, encrypted, "b")).rejects.toThrow(Error);
        await expect(decryptSecret(KEY, encrypted)).rejects.toThrow(Error);
    });

    it("refuses a sealed value copied into another organization's, environment's or name's row", async () => {
        const sealed = await sealSecret(KEY, orgA, "production", "API_KEY", "s3cret");

        await expect(openSecret(KEY, orgA, { ...sealed, environment: "production", name: "API_KEY" })).resolves.toBe("s3cret");
        await expect(openSecret(KEY, orgB, { ...sealed, environment: "production", name: "API_KEY" })).rejects.toThrow(Error);
        await expect(openSecret(KEY, orgA, { ...sealed, environment: "all", name: "API_KEY" })).rejects.toThrow(Error);
        await expect(openSecret(KEY, orgA, { ...sealed, environment: "production", name: "OTHER" })).rejects.toThrow(Error);
    });

    it("still decrypts a row written before the binding", async () => {
        const legacy = await encryptSecret(KEY, "old-value");

        await expect(openSecret(KEY, orgA, { ...legacy, environment: "all", name: "API_KEY" })).resolves.toBe("old-value");
    });

    it("decrypts a deploy's mix of bound shared rows and unbound kind rows, each against its own environment", async () => {
        const rows = [
            { ...(await sealSecret(KEY, orgA, "all", "SHARED", "shared-value")), environment: "all", name: "SHARED" },
            { ...(await encryptSecret(KEY, "prod-value")), environment: "production", name: "PROD_ONLY" },
        ];

        await expect(decryptSecrets(secretsForKind(rows, "production"), orgA, KEY)).resolves.toStrictEqual({ PROD_ONLY: "prod-value", SHARED: "shared-value" });
    });

    it("marks every stored row bound, so an unbound ciphertext copied in no longer decrypts", async () => {
        const { ctx, ops } = makeCtx({ members: [owner("org_b")], projects: [{ _id: "proj_b", organizationId: "org_b" }], secrets: [] });
        const legacy = await encryptSecret(KEY, "org-a-value");

        await store.handler(ctx, { ...legacy, name: "API_KEY", organizationId: "org_b" as never, projectId: "proj_b" as never });

        const [row] = ops.flatMap((op) =>
            op.kind === "insert" && op.table === "secrets" ? [op.document as Record<string, unknown> & { ciphertext: string; iv: string }] : [],
        );

        expect(row.cipherVersion).toBe(SECRET_CIPHER_VERSION);
        await expect(openSecret(KEY, orgB, { ...row, environment: "all", name: "API_KEY" })).rejects.toThrow(Error);
    });
});
