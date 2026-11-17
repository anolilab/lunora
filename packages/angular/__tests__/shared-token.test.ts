import { describe, expect, it, vi } from "vitest";

// Two module instances of this package, as a bundle holding two pnpm peer variants has them.
const loadCopy = async (): Promise<typeof import("../src/client")> => {
    vi.resetModules();

    return import("../src/client");
};

describe("the LUNORA_CLIENT token across copies of the package", () => {
    it("two copies share one injection token, so a provider from one satisfies an injection from the other", async () => {
        expect.assertions(2);

        const providerCopy = await loadCopy();
        const injectorCopy = await loadCopy();

        // Only a real second copy makes this test mean anything.
        expect(injectorCopy.injectLunoraClient).not.toBe(providerCopy.injectLunoraClient);
        expect(injectorCopy.LUNORA_CLIENT).toBe(providerCopy.LUNORA_CLIENT);
    });
});
