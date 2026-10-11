import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import type { TombstonePort } from "../src/tombstones";
import { assertSubjectId, subjectsToReerase, tombstoneKeyOf } from "../src/tombstones";

const HEX_DIGEST = /^[0-9a-f]{64}$/u;

const memoryTombstones = (): TombstonePort & { stored: Map<string, Date> } => {
    const stored = new Map<string, Date>();

    return {
        add: async (key, erasedAt) => {
            stored.set(key, erasedAt);
        },
        keys: async () => new Set(stored.keys()),
        stored,
    };
};

describe(tombstoneKeyOf, () => {
    it("is a stable SHA-256 hex digest, not the raw id", async () => {
        const key = tombstoneKeyOf("u1");

        expect(key).toMatch(HEX_DIGEST);
        expect(key).toBe(tombstoneKeyOf("u1"));
        expect(key).not.toContain("u1");
    });
});

describe(subjectsToReerase, () => {
    it("returns only the restored subjects that were erased after the backup", async () => {
        const tombstones = memoryTombstones();

        await tombstones.add(tombstoneKeyOf("u2"), new Date("2026-10-11T00:00:00.000Z"));

        await expect(subjectsToReerase(["u1", "u2", "u2"], tombstones)).resolves.toStrictEqual(["u2"]);
    });

    it("returns nothing when no restored subject was erased", async () => {
        await expect(subjectsToReerase(["u1"], memoryTombstones())).resolves.toStrictEqual([]);
    });
});

describe(assertSubjectId, () => {
    it("refuses an empty subject id", () => {
        expect(() => {
            assertSubjectId("  ");
        }).toThrow(LunoraError);
    });

    it("accepts a real id", () => {
        expect(() => {
            assertSubjectId("u1");
        }).not.toThrow();
    });
});
