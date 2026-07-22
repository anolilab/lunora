import { describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";

/** Minimal `EmitAppOptions` with every capability off; tests flip one flag at a time. */
const baseOptions = {
    hasAccess: false,
    hasAi: false,
    hasAnalytics: false,
    hasAuth: false,
    hasBrowser: false,
    hasFramework: false,
    hasGlobal: false,
    hasHyperdrive: false,
    hasHyperdriveGlobal: false,
    hasImages: false,
    hasKv: false,
    hasNotify: false,
    hasPayments: false,
    hasQueue: false,
    hasR2sql: false,
    hasScheduler: false,
    hasStorage: false,
    hasVectors: false,
    hasWorkflow: false,
    hasX402: false,
    useUmbrella: false,
    wantsOpenApi: false,
    wantsOpenRpc: false,
};

describe("emitApp — Cloudflare Access", () => {
    it("emits the .access() method, field and import when the package is a dependency", () => {
        expect.assertions(4);

        const output = emitApp({ ...baseOptions, hasAccess: true });

        expect(output).toContain("public access(selector: Selector<Env, CreateAccessResolverOptions>): this");
        expect(output).toContain("private accessSelector?: Selector<Env, CreateAccessResolverOptions>;");
        expect(output).toContain('import type { CreateAccessResolverOptions } from "@lunora/cloudflare-access";');
        expect(output).toContain('import { createAccessResolver } from "@lunora/cloudflare-access";');
    });

    it("sets resolveIdentity directly (no compose) when Access is used without auth", () => {
        expect.assertions(3);

        const output = emitApp({ ...baseOptions, hasAccess: true });

        expect(output).toContain("options.resolveIdentity = createAccessResolver(this.accessSelector(env));");
        // composeResolvers is only needed to fall back to a better-auth resolver.
        expect(output).not.toContain("composeResolvers");
        expect(output).not.toContain("import { createAccessResolver, composeResolvers }");
    });

    it("composes Access ahead of the better-auth resolver when both are present", () => {
        expect.assertions(3);

        const output = emitApp({ ...baseOptions, hasAccess: true, hasAuth: true });

        expect(output).toContain('import { createAccessResolver, composeResolvers } from "@lunora/cloudflare-access";');
        expect(output).toContain("const fallback = options.resolveIdentity;");
        expect(output).toContain("options.resolveIdentity = fallback ? composeResolvers(accessResolver, fallback) : accessResolver;");
    });

    it("emits nothing Access-related when the package is not a dependency", () => {
        expect.assertions(2);

        const output = emitApp(baseOptions);

        expect(output).not.toContain("@lunora/cloudflare-access");
        expect(output).not.toContain("accessSelector");
    });
});
