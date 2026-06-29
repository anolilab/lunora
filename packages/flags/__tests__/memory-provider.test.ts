import { afterEach, describe, expect, it, vi } from "vitest";

import { createFlags, resetFlags } from "../src/flags";
import type { MemoryFlagValue } from "../src/providers/memory";
import { memoryProvider } from "../src/providers/memory";

afterEach(async () => {
    await resetFlags();
    vi.restoreAllMocks();
});

// `memoryProvider` is a `FlagsProviderFactory` ((env) => Provider); codegen wraps it
// as `() => factory(env)`. Memory flags ignore env, so bind with an empty one.
const flagsFor = (map: Record<string, MemoryFlagValue>) => {
    const factory = memoryProvider(map);

    return createFlags({ provider: () => factory({}) });
};

describe("memoryProvider", () => {
    it("resolves each flag type from the static map", async () => {
        const flags = flagsFor({
            "dark-mode": true,
            "page-size": 25,
            "homepage-hero": "control",
            rollout: { percent: 10, regions: ["us", "eu"] },
        });

        await expect(flags.boolean("dark-mode", false)).resolves.toBe(true);
        await expect(flags.number("page-size", 10)).resolves.toBe(25);
        await expect(flags.string("homepage-hero", "fallback")).resolves.toBe("control");
        await expect(flags.object("rollout", {})).resolves.toEqual({ percent: 10, regions: ["us", "eu"] });
    });

    it("reports a STATIC reason for a configured flag", async () => {
        const flags = flagsFor({ "dark-mode": true });

        const details = await flags.details.boolean("dark-mode", false);

        expect(details.value).toBe(true);
        expect(details.reason).toBe("STATIC");
    });

    it("falls back to the call default for an unknown flag", async () => {
        const flags = flagsFor({ "dark-mode": true });

        await expect(flags.boolean("missing", false)).resolves.toBe(false);
        await expect(flags.string("missing", "fallback")).resolves.toBe("fallback");
    });

    it("fails open to the default on a type mismatch (number read as boolean)", async () => {
        const flags = flagsFor({ "page-size": 25 });

        await expect(flags.boolean("page-size", false)).resolves.toBe(false);
    });

    it("reuses one provider instance across env-less factory calls", () => {
        const factory = memoryProvider({ "dark-mode": true });

        expect(factory({})).toBe(factory({ SOMETHING: "else" }));
    });
});
