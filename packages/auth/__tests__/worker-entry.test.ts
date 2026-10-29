import { describe, expect, it } from "vitest";

describe("@lunora/auth/worker", () => {
    it("exports the same functions as the barrel, so the generated app gets the real implementations", async () => {
        expect.hasAssertions();

        const barrel: Record<string, unknown> = await import("../src/index");
        const worker: Record<string, unknown> = await import("../src/worker");

        // The entry imports each name straight from its module to keep the barrel out
        // of the generated app's `import()`; a name it re-exported from anywhere else
        // would hand the worker a different function than `@lunora/auth` does.
        for (const [name, value] of Object.entries(worker)) {
            expect(value, name).toBe(barrel[name]);
        }
    });
});
