import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The domain lists (~3 MB of data) must not be evaluated at import time.
 *
 * On a Worker every byte evaluated at module scope counts against the 1 s startup
 * limit, and `@lunora/auth` is imported by every app that uses it — most requests
 * never reach a signup check. So the lists load on the FIRST gated check, and
 * importing the guard (or the package barrels it sits behind) loads nothing.
 *
 * Each `/domains` subpath is mocked with a counting factory, so a regression to a
 * static (or otherwise eager) import shows up as a non-zero count straight after
 * `import("../src/email-guard")`.
 */

const evaluated = { disposable: 0, free: 0 };

const mockLists = (): void => {
    vi.doMock(import("@visulima/disposable-email-domains/domains"), () => {
        evaluated.disposable += 1;

        return { default: ["mailinator.com"] };
    });
    vi.doMock(import("@visulima/free-email-domains/domains"), () => {
        evaluated.free += 1;

        return { default: ["gmail.com"] };
    });
};

describe("email guard — lazy list loading", () => {
    afterEach(() => {
        evaluated.disposable = 0;
        evaluated.free = 0;
        vi.doUnmock("@visulima/disposable-email-domains/domains");
        vi.doUnmock("@visulima/free-email-domains/domains");
        vi.resetModules();
    });

    it("does not evaluate either domain list when the module is imported", async () => {
        expect.assertions(4);

        vi.resetModules();
        mockLists();

        await import("../src/email-guard");
        // The gate sits behind the same import graph; importing it must not load either.
        await import("../src/email-gate");

        expect(evaluated).toStrictEqual({ disposable: 0, free: 0 });

        // The package-side view of the same fact: nothing was injected or read from disk.
        const disposable = await import("@visulima/disposable-email-domains");
        const free = await import("@visulima/free-email-domains");

        expect(disposable.isListLoaded()).toBe(false);
        expect(free.isListLoaded()).toBe(false);
        expect(evaluated).toStrictEqual({ disposable: 0, free: 0 });
    });

    it("loads the lists once, on the first gated check", async () => {
        expect.assertions(3);

        vi.resetModules();
        mockLists();

        const { assertEmailAllowed } = await import("../src/email-guard");

        expect(evaluated).toStrictEqual({ disposable: 0, free: 0 });

        await expect(assertEmailAllowed("someone@gmail.com")).resolves.toMatchObject({ emailClass: "free" });

        await assertEmailAllowed("someone@example.com");

        // One evaluation each, however many checks run.
        expect(evaluated).toStrictEqual({ disposable: 1, free: 1 });
    });

    it("loads only the disposable list for the default middleware", async () => {
        expect.assertions(1);

        vi.resetModules();
        mockLists();

        const { emailGateMiddleware } = await import("../src/email-guard");
        const gate = emailGateMiddleware<{ email: string }>({ email: (ctx) => ctx.email });

        await gate({ ctx: { email: "a@example.com" }, next: async () => {} } as never);

        expect(evaluated).toStrictEqual({ disposable: 1, free: 0 });
    });

    it("loads both lists when the middleware has an onClassify observer", async () => {
        expect.assertions(1);

        vi.resetModules();
        mockLists();

        const { emailGateMiddleware } = await import("../src/email-guard");
        const gate = emailGateMiddleware<{ email: string }>({ email: (ctx) => ctx.email, onClassify: () => {} });

        await gate({ ctx: { email: "a@example.com" }, next: async () => {} } as never);

        expect(evaluated).toStrictEqual({ disposable: 1, free: 1 });
    });

    it("loads neither list with blockDisposable false and no observer", async () => {
        expect.assertions(1);

        vi.resetModules();
        mockLists();

        const { emailGateMiddleware } = await import("../src/email-guard");
        const gate = emailGateMiddleware<{ email: string }>({ email: (ctx) => ctx.email, blockDisposable: false });

        await gate({ ctx: { email: "a@example.com" }, next: async () => {} } as never);

        expect(evaluated).toStrictEqual({ disposable: 0, free: 0 });
    });
});
