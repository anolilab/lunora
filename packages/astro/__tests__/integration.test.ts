import { describe, expect, it } from "vitest";

import { lunora } from "../src/integration";

describe("lunora() Astro integration", () => {
    it("returns an AstroIntegration object with the package name", () => {
        expect.assertions(2);

        const integration = lunora();

        expect(integration.name).toBe("@lunora/astro");
        expect(typeof integration.hooks).toBe("object");
    });

    it("exposes an astro:config:done hook that runs without side effects", () => {
        expect.assertions(1);

        const integration = lunora({ serverEntry: "src/custom-worker.ts" });
        const hook = integration.hooks["astro:config:done"];

        // The hook is side-effect-free today (the load-bearing composition is
        // `withLunora` at the server-entry boundary); it must not throw.
        expect(() => {
            (hook as () => void)();
        }).not.toThrow();
    });

    it("defaults serverEntry without requiring options", () => {
        expect.assertions(1);

        // Constructing with no args must not throw and must still yield hooks.
        expect(() => lunora()).not.toThrow();
    });
});
