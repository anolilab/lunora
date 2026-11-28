import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultProbe } from "../../src/util/dev-probe";

const rejectWith = (code: string): void => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) })));
};

describe(defaultProbe, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("counts a server whose TLS certificate this machine does not trust as answering", async () => {
        expect.assertions(1);

        rejectWith("DEPTH_ZERO_SELF_SIGNED_CERT");

        await expect(defaultProbe("https://localhost:5173")).resolves.toBe(true);
    });

    it("does not count a refused connection", async () => {
        expect.assertions(1);

        rejectWith("ECONNREFUSED");

        await expect(defaultProbe("https://localhost:5173")).resolves.toBe(false);
    });
});
