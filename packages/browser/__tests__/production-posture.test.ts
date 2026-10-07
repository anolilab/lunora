import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeBinding } from "./_helpers/fake-launch";

/**
 * The warning is once per isolate (module state), so every test loads a fresh
 * copy of the factory.
 */
const freshCreateBrowser = async () => {
    vi.resetModules();

    const module = await import("../src/create-browser");

    return module.createBrowser;
};

describe("the no-allowedHosts production-posture warning", () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
        warn.mockRestore();
    });

    it("warns once per isolate when a factory has no allowedHosts, pointing at allowedHosts", async () => {
        expect.assertions(2);

        const createBrowser = await freshCreateBrowser();

        createBrowser({ binding: fakeBinding() });
        createBrowser({ binding: fakeBinding() });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toMatch(/Set `allowedHosts`/u);
    });

    it("does not warn when allowedHosts is set", async () => {
        expect.assertions(1);

        const createBrowser = await freshCreateBrowser();

        createBrowser({ allowedHosts: ["example.com"], binding: fakeBinding() });

        expect(warn).not.toHaveBeenCalled();
    });

    it("does not warn when allowPrivateTargets opts out of the guard on purpose", async () => {
        expect.assertions(1);

        const createBrowser = await freshCreateBrowser();

        createBrowser({ allowPrivateTargets: true, binding: fakeBinding() });

        expect(warn).not.toHaveBeenCalled();
    });
});
