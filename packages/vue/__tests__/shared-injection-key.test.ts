import { describe, expect, it, vi } from "vitest";

// Two module instances of this package, as a bundle holding two pnpm peer variants has them.
const loadCopy = async (): Promise<typeof import("../src/lunora-provider")> => {
    vi.resetModules();

    return import("../src/lunora-provider");
};

describe("the injection key across copies of the package", () => {
    it("two copies share one injection key, so a client provided by one is injected by the other", async () => {
        expect.assertions(2);

        const providerCopy = await loadCopy();
        const injectorCopy = await loadCopy();

        // Only a real second copy makes this test mean anything.
        expect(injectorCopy.useLunora).not.toBe(providerCopy.useLunora);
        expect(injectorCopy.LUNORA_INJECTION_KEY).toBe(providerCopy.LUNORA_INJECTION_KEY);
    });
});
