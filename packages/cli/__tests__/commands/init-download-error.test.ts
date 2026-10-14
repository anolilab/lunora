import { describe, expect, it } from "vitest";

import describeDownloadFailure from "../../src/commands/init/download-failure";

const context = { ref: "alpha", remote: "gh:anolilab/lunora/templates/vite#alpha", templateType: "vite" };

describe("describeDownloadFailure", () => {
    it("classifies a network/offline error with a --from hint", () => {
        expect.assertions(3);

        const { hints, message } = describeDownloadFailure(new Error("getaddrinfo ENOTFOUND github.com"), context);

        expect(message).toContain("vite");
        expect(message).toContain("getaddrinfo ENOTFOUND github.com");
        expect(hints.some((hint) => hint.includes("--from"))).toBe(true);
    });

    it("classifies a 404 as not found with a --ref hint", () => {
        expect.assertions(3);

        const { hints, message } = describeDownloadFailure(new Error("404 Not Found"), context);

        expect(message).toContain("not found");
        expect(message).toContain("vite");
        expect(hints.some((hint) => hint.includes("--ref"))).toBe(true);
    });

    it("falls back to a generic message with the offline hint for unknown errors", () => {
        expect.assertions(3);

        const { hints, message } = describeDownloadFailure(new Error("boom"), context);

        expect(message).toContain("failed to download template");
        expect(message).toContain("boom");
        expect(hints.some((hint) => hint.includes("--from"))).toBe(true);
    });
});
