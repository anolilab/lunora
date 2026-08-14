import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Coverage for the construction-time warning `plugins-enterprise.ts` wraps around
 * `@better-auth/sso`'s `sso()` export (plan 350). `enterprise-auth.behaviour.test.ts`
 * already drives the real better-auth runtime through `sso()`; this file isolates the
 * wrapper's own contract instead: it must warn exactly once when `domainVerification`
 * is not explicitly enabled, stay silent when it is, and hand every option to
 * `@better-auth/sso` untouched — an option mutation here would silently change auth
 * behaviour, which is the worst class of regression in this package.
 *
 * `@better-auth/sso`'s real `sso()` is spied rather than replaced: the spy delegates to
 * the actual implementation, so what these tests observe is the exact call the wrapper
 * makes, not a stand-in.
 */

// `plugins-enterprise.ts` imports `sso` statically, so the spy must exist before that
// import is linked — `vi.hoisted` runs first and sidesteps the TDZ (mirrors
// `email-gate.test.ts`'s `assertEmailAllowed` mock). Untyped: `sso`'s real signature is
// an overloaded generic (see `plugins-enterprise.ts`), which a `Mock<...>` wrapper can't
// structurally match — the cast back to `typeof actual.sso` below is what the mock
// factory needs to satisfy, not this declaration.
const { ssoSpy } = vi.hoisted(() => {
    return { ssoSpy: vi.fn<(...args: unknown[]) => unknown>() };
});

vi.mock(import("@better-auth/sso"), async (importOriginal) => {
    const actual = await importOriginal();

    ssoSpy.mockImplementation(actual.sso);

    return { ...actual, sso: ssoSpy as typeof actual.sso };
});

const { sso } = await import("../src/plugins-enterprise");

describe("sso() domain-verification warning", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        ssoSpy.mockClear();
    });

    it("warns once, naming domainVerification and /sso/register, when domainVerification is not enabled", () => {
        expect.assertions(3);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        sso();

        expect(warn).toHaveBeenCalledTimes(1);

        const message = warn.mock.calls[0]?.[0] as string;

        expect(message).toMatch(/domainVerification/);
        expect(message).toMatch(/\/sso\/register/);
    });

    it("does not warn when domainVerification.enabled is explicitly true", () => {
        expect.assertions(1);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        sso({ domainVerification: { enabled: true } });

        expect(warn).not.toHaveBeenCalled();
    });

    it("hands the caller's options to @better-auth/sso untouched, whether or not it warns", () => {
        expect.assertions(2);

        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const insecureOptions = { providersLimit: 3 };

        sso(insecureOptions);

        expect(ssoSpy.mock.calls[0]?.[0]).toEqual(insecureOptions);

        ssoSpy.mockClear();

        const verifiedOptions = { domainVerification: { enabled: true as const }, providersLimit: 1 };

        sso(verifiedOptions);

        expect(ssoSpy.mock.calls[0]?.[0]).toEqual(verifiedOptions);
    });

    it("fires the warning once per construction call, not once per option read or endpoint use", () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const plugin = sso();

        // Touching the constructed plugin's surface (as a real caller reading endpoints
        // off it would) must not trigger a second warning — the check runs once, at the
        // `sso()` call itself, never lazily per read.
        expect(Object.keys(plugin.endpoints).length).toBeGreaterThan(0);
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
