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

    it("accepts construction with an empty serverEntry but rejects it when the hook runs", () => {
        expect.assertions(2);

        // `??` only substitutes the default for null/undefined, so an explicit
        // empty string survives and must be caught by the hook's guard rather
        // than silently composing a worker against an unresolvable entry.
        const integration = lunora({ serverEntry: "" });

        expect(() => integration).not.toThrow();

        const hook = integration.hooks["astro:config:done"];

        expect(() => {
            (hook as () => void)();
        }).toThrow(/serverEntry/);
    });

    it("rejects a whitespace-only serverEntry when the hook runs", () => {
        expect.assertions(1);

        // A whitespace-only path is just as unresolvable as an empty string;
        // the guard trims before the emptiness check so it is caught too.
        const integration = lunora({ serverEntry: "   " });
        const hook = integration.hooks["astro:config:done"];

        expect(() => {
            (hook as () => void)();
        }).toThrow(/serverEntry/);
    });
});
