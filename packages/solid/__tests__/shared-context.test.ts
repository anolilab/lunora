import { describe, expect, it, vi } from "vitest";

// Two copies of this package on one Solid runtime. `vi.resetModules()` re-evaluates `solid-js` too, which would give each copy a
// new `createContext` and so a different runtime. A single `createContext` is kept across the reset, as one installed Solid is.
const runtime: { createContext?: unknown } = vi.hoisted(() => {
    return {};
});

vi.mock(import("solid-js"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("solid-js")>();

    runtime.createContext ??= actual.createContext;

    return { ...actual, createContext: runtime.createContext as typeof actual.createContext };
});

// Two module instances of this package, as a bundle holding two pnpm peer variants has them.
const loadCopy = async (): Promise<typeof import("../src/context")> => {
    vi.resetModules();

    return import("../src/context");
};

describe("the Solid contexts across copies of the package", () => {
    it("two copies share one LunoraContext, so a provider from one is read by the other", async () => {
        expect.assertions(2);

        const providerCopy = await loadCopy();
        const readerCopy = await loadCopy();

        // Only a real second copy makes this test mean anything.
        expect(readerCopy.useLunora).not.toBe(providerCopy.useLunora);
        expect(readerCopy.LunoraContext).toBe(providerCopy.LunoraContext);
    });

    it("two copies share one LunoraClientSwappedContext", async () => {
        expect.assertions(1);

        const providerCopy = await loadCopy();
        const readerCopy = await loadCopy();

        expect(readerCopy.LunoraClientSwappedContext).toBe(providerCopy.LunoraClientSwappedContext);
    });
});
