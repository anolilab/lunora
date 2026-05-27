import { describe, expect, test } from "vitest";

import { hashPassword, verifyPassword } from "../src/pbkdf2.js";

describe("pbkdf2", () => {
    test("hash + verify roundtrips for the correct password", async () => {
        // Use the minimum acceptable iteration count (100_000) — anything lower
        // is rejected by verifyPassword to guarantee we never validate against
        // weak legacy material. See audit C5/H2.
        const hash = await hashPassword("hunter2", 100_000);

        expect(hash.startsWith("pbkdf2$100000$")).toBe(true);
        await expect(verifyPassword("hunter2", hash)).resolves.toBe(true);
    });

    test("rejects an incorrect password", async () => {
        const hash = await hashPassword("hunter2", 100_000);

        await expect(verifyPassword("hunter3", hash)).resolves.toBe(false);
    });

    test("rejects hashes with weak iteration counts (< 100_000)", async () => {
        const weak = await hashPassword("hunter2", 1000);

        await expect(verifyPassword("hunter2", weak)).resolves.toBe(false);
    });

    test("rejects a malformed stored hash", async () => {
        await expect(verifyPassword("hunter2", "not-a-hash")).resolves.toBe(false);
        await expect(verifyPassword("hunter2", "pbkdf2$abc$salt$hash")).resolves.toBe(false);
    });

    test("each call produces a fresh salt", async () => {
        const a = await hashPassword("hunter2", 100_000);
        const b = await hashPassword("hunter2", 100_000);

        expect(a).not.toBe(b);
    });
});
