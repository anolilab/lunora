import { LunoraError } from "@lunora/errors";
import { describe, expect, it, vi } from "vitest";

import type { EmailClassification } from "../src/email-guard";
import { assertEmailAllowed, classifyEmail, emailGateMiddleware, loadEmailDomainLists } from "../src/email-guard";

type CheckMxRecords = typeof import("@visulima/email-verifier/checks/mx").checkMxRecords;

// Spy on the DNS-backed MX module so we can assert the default path never
// touches it (edge-safety) and the opt-in path does.
const checkMxRecords = vi.fn<CheckMxRecords>(() =>
    Promise.resolve({ domainResolves: true, records: [{ exchange: "mx", priority: 10 }], resolvedVia: "mx", valid: true }),
);

vi.mock(import("@visulima/email-verifier/checks/mx"), () => {
    return { checkMxRecords };
});

describe("classifyEmail", () => {
    it("classifies a free consumer provider as free", async () => {
        expect.assertions(1);

        await loadEmailDomainLists();

        expect(classifyEmail("user@gmail.com").emailClass).toBe("free");
    });

    it("classifies a custom company domain as business", async () => {
        expect.assertions(1);

        await loadEmailDomainLists();

        expect(classifyEmail("founder@acme-corp.example").emailClass).toBe("business");
    });

    it("classifies a built-in disposable domain as disposable", async () => {
        expect.assertions(1);

        await loadEmailDomainLists();

        expect(classifyEmail("throwaway@mailinator.com").emailClass).toBe("disposable");
    });

    it("classifies a Unicode-form internationalized disposable domain as disposable", async () => {
        expect.assertions(2);

        await loadEmailDomainLists();

        // The blocklists are ASCII-only (`xn--…` entries, no Unicode ones), so a
        // caller submitting the Unicode form of a listed IDN must still be folded
        // to punycode before the lookup or the gate is bypassed outright.
        const classification = classifyEmail("a@пушка-тула.рф");

        expect(classification.emailClass).toBe("disposable");
        expect(classification.domain).toBe("xn----7sbb1bhuyee9b.xn--p1ai");
    });

    it("honours a custom denyDomains list", async () => {
        expect.assertions(1);

        await loadEmailDomainLists();

        expect(classifyEmail("a@throwaway.test", { denyDomains: ["throwaway.test"] }).emailClass).toBe("disposable");
    });

    it("lets allowDomains override the built-in free/disposable lists", async () => {
        expect.assertions(2);

        await loadEmailDomainLists();

        expect(classifyEmail("user@gmail.com", { allowDomains: ["gmail.com"] }).emailClass).toBe("business");
        expect(classifyEmail("x@mailinator.com", { allowDomains: ["mailinator.com"] }).emailClass).toBe("business");
    });

    it("returns an undefined domain for a structurally invalid address", () => {
        expect.assertions(2);

        const result = classifyEmail("not-an-email");

        expect(result.domain).toBeUndefined();
        expect(result.emailClass).toBe("business");
    });
});

describe("assertEmailAllowed — gating", () => {
    it("rejects a disposable signup with the EMAIL_DOMAIN_BLOCKED code", async () => {
        expect.assertions(2);

        const rejection = assertEmailAllowed("spammer@mailinator.com");

        await expect(rejection).rejects.toBeInstanceOf(LunoraError);
        await expect(rejection).rejects.toMatchObject({ code: "EMAIL_DOMAIN_BLOCKED", status: 400 });
    });

    it("also rejects a denyDomains hit", async () => {
        expect.assertions(1);

        await expect(assertEmailAllowed("a@banned.test", { denyDomains: ["banned.test"] })).rejects.toMatchObject({
            code: "EMAIL_DOMAIN_BLOCKED",
        });
    });

    it("lets a business email through and returns its classification", async () => {
        expect.assertions(2);

        const result = await assertEmailAllowed("cto@acme-corp.example");

        expect(result.emailClass).toBe("business");
        expect(result.domain).toBe("acme-corp.example");
    });

    it("does not block when blockDisposable is false (classify-only)", async () => {
        expect.assertions(1);

        const result = await assertEmailAllowed("x@mailinator.com", { blockDisposable: false });

        expect(result.emailClass).toBe("disposable");
    });

    it("rejects a structurally invalid address with VALIDATION_ERROR", async () => {
        expect.assertions(1);

        await expect(assertEmailAllowed("nope@@bad")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });
});

describe("assertEmailAllowed — edge-safety (DNS is opt-in)", () => {
    it("makes NO MX/DNS call on the default path", async () => {
        expect.assertions(2);

        checkMxRecords.mockClear();

        const result = await assertEmailAllowed("cto@acme-corp.example");

        expect(result.emailClass).toBe("business");
        expect(checkMxRecords).not.toHaveBeenCalled();
    });

    it("runs the MX check only when mx: true is opted in", async () => {
        expect.assertions(1);

        checkMxRecords.mockClear();

        await assertEmailAllowed("cto@acme-corp.example", { mx: true });

        expect(checkMxRecords).toHaveBeenCalledWith("acme-corp.example");
    });

    it("rejects an undeliverable domain (no MX) with EMAIL_UNDELIVERABLE when mx is on", async () => {
        expect.assertions(1);

        checkMxRecords.mockResolvedValueOnce({ domainResolves: false, records: [], resolvedVia: "none", valid: false });

        await expect(assertEmailAllowed("cto@acme-corp.example", { mx: true })).rejects.toMatchObject({ code: "EMAIL_UNDELIVERABLE" });
    });
});

/**
 * The shape `@lunora/server`'s procedure builder actually hands a `.use()` step:
 * the call's VALIDATED arguments, frozen, on `ctx.args` (see `withCallContext`
 * in `packages/server/src/builder/index.ts`). A signup email arrives in the
 * request body and nowhere else, so this is the only shape the documented
 * `email` selector can read.
 */
describe("emailGateMiddleware over the builder's ctx.args", () => {
    interface ArgsCtx {
        args: { email?: string };
    }

    /** Drive a middleware and report whether `next` ran (the handler proceeded). */
    const run = async (ctx: ArgsCtx, config: Parameters<typeof emailGateMiddleware<ArgsCtx>>[0]): Promise<{ passed: boolean }> => {
        let passed = false;
        const middleware = emailGateMiddleware<ArgsCtx>(config);
        const next = (async (): Promise<ArgsCtx> => {
            passed = true;

            return ctx;
        }) as Parameters<typeof middleware>[0]["next"];

        await middleware({ ctx, next });

        return { passed };
    };

    const builderCtx = (args: { email?: string }): ArgsCtx => {
        return { args: Object.freeze(args) };
    };

    it("admits a business address routed through the function args", async () => {
        expect.assertions(2);

        const onClassify = vi.fn<(classification: EmailClassification, context: ArgsCtx) => void>();
        const { passed } = await run(builderCtx({ email: "cto@acme-corp.example" }), { email: (ctx) => ctx.args.email, onClassify });

        expect(passed).toBe(true);
        expect(onClassify).toHaveBeenCalledWith({ domain: "acme-corp.example", emailClass: "business" }, expect.anything());
    });

    it("blocks a disposable address before the handler runs", async () => {
        expect.assertions(2);

        const rejection = run(builderCtx({ email: "spammer@mailinator.com" }), { email: (ctx) => ctx.args.email });

        await expect(rejection).rejects.toBeInstanceOf(LunoraError);
        await expect(rejection).rejects.toMatchObject({ code: "EMAIL_DOMAIN_BLOCKED" });
    });

    it("rejects when the procedure declared no email arg", async () => {
        expect.assertions(1);

        await expect(run(builderCtx({}), { email: (ctx) => ctx.args.email })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });
});
