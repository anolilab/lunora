import { describe, expect, it, vi } from "vitest";

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
