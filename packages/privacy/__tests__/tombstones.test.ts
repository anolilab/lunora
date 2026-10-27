import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import type { TombstonePort } from "../src/tombstones";
import { subjectsToReerase, tombstoneKeyOf } from "../src/tombstones";

const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const SECRET = "test-tombstone-secret";
/** HMAC-SHA256 of "u1" under {@link SECRET}, computed outside the package (openssl dgst -sha256 -hmac). */
const U1_KEY = "d8f17398947ab20004ba0182ca0911462a689032f31fd433d45d48bfc76d363e";

const memoryTombstones = (): TombstonePort & { stored: Map<string, Date> } => {
    const stored = new Map<string, Date>();

    return {
        add: async (key, erasedAt) => {
            stored.set(key, erasedAt);
        },
        has: async (key) => stored.has(key),
        keys: async () => new Set(stored.keys()),
        stored,
    };
};

describe(tombstoneKeyOf, () => {
    it("is the HMAC-SHA256 of the id under the secret, as lowercase hex", () => {
        const key = tombstoneKeyOf("u1", SECRET);

        expect(key).toMatch(HEX_DIGEST);
        expect(key).toBe(U1_KEY);
        expect(key).not.toContain("u1");
    });

    it("gives a different key under a different secret", () => {
        expect(tombstoneKeyOf("u1", SECRET)).not.toBe(tombstoneKeyOf("u1", "another-secret"));
    });
});

describe(subjectsToReerase, () => {
    it("returns only the restored subjects that were erased after the backup", async () => {
        const tombstones = memoryTombstones();

        await tombstones.add(tombstoneKeyOf("u2", SECRET), new Date("2026-10-11T00:00:00.000Z"));

        await expect(subjectsToReerase(["u1", "u2", "u2"], tombstones, SECRET)).resolves.toStrictEqual(["u2"]);
    });

    it("returns nothing when no restored subject was erased", async () => {
        await expect(subjectsToReerase(["u1"], memoryTombstones(), SECRET)).resolves.toStrictEqual([]);
    });
});

describe("tombstoneKeyOf on an empty id", () => {
    it("refuses an empty subject id rather than keying every empty id alike", () => {
        expect(() => tombstoneKeyOf("  ", SECRET)).toThrow(LunoraError);
    });
});
