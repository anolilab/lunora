/* eslint-disable vitest/prefer-import-in-mock -- the string-specifier form is intentional: these mocks return deliberately malformed module shapes (missing/non-function exports) that the typed `import()` form rejects. */
import type { Plugin } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each case re-imports the plugin module fresh (vi.resetModules) so the
// module-level `warned` dedup flag and the dynamic import are re-evaluated
// against whichever `@visulima/vite-overlay` mock the case installed.
const loadOverlayPlugin = async (): Promise<() => Promise<Plugin | ReadonlyArray<Plugin>>> => {
    const imported = await import("../src/overlay-plugin.js");

    return imported.default;
};

describe("overlayPlugin", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.doUnmock("@visulima/vite-overlay");
        vi.restoreAllMocks();
    });

    it("returns the result of the default-export factory", async () => {
        expect.assertions(1);

        const created: Plugin = { name: "overlay:from-default" };

        vi.doMock("@visulima/vite-overlay", () => {
            return { default: () => created };
        });

        const overlayPlugin = await loadOverlayPlugin();
        const result = await overlayPlugin();

        expect(result).toBe(created);
    });

    it("falls back to the named `overlay` export when there is no default", async () => {
        expect.assertions(1);

        const created: Plugin = { name: "overlay:from-named" };

        // `default: undefined` mirrors a real ESM namespace with no default
        // export — vitest's mock proxy throws on access to an undeclared key.
        vi.doMock("@visulima/vite-overlay", () => {
            return { default: undefined, overlay: () => created };
        });

        const overlayPlugin = await loadOverlayPlugin();
        const result = await overlayPlugin();

        expect(result).toBe(created);
    });

    it("falls back to the named `viteOverlay` export", async () => {
        expect.assertions(1);

        const created: Plugin = { name: "overlay:from-vite-overlay" };

        vi.doMock("@visulima/vite-overlay", () => {
            return { default: undefined, overlay: undefined, viteOverlay: () => created };
        });

        const overlayPlugin = await loadOverlayPlugin();
        const result = await overlayPlugin();

        expect(result).toBe(created);
    });

    it("returns the no-op injector and warns when no factory export is a function", async () => {
        expect.assertions(3);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        vi.doMock("@visulima/vite-overlay", () => {
            return { default: "not-a-function", overlay: undefined, viteOverlay: undefined };
        });

        const overlayPlugin = await loadOverlayPlugin();
        const result = await overlayPlugin();

        expect(result).toStrictEqual({ apply: "serve", name: "cirrus:overlay-injector" });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toContain("overlay disabled");
    });

    it("returns the no-op injector when the import itself rejects", async () => {
        expect.assertions(2);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        vi.doMock("@visulima/vite-overlay", () => {
            throw new Error("module not installed");
        });

        const overlayPlugin = await loadOverlayPlugin();
        const result = await overlayPlugin();

        expect(result).toStrictEqual({ apply: "serve", name: "cirrus:overlay-injector" });
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("warns at most once per process across repeated calls", async () => {
        expect.assertions(1);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        vi.doMock("@visulima/vite-overlay", () => {
            throw new Error("module not installed");
        });

        const overlayPlugin = await loadOverlayPlugin();

        await overlayPlugin();
        await overlayPlugin();
        await overlayPlugin();

        expect(warnSpy).toHaveBeenCalledTimes(1);
    });
});
