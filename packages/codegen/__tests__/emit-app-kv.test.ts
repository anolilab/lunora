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

describe("emitApp — KV introspector wiring", () => {
    it("wires the studio KV browser by scanning `env` for every KV namespace when `ctx.kv` is used", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasKv: true });

        expect(output).toContain('import { createKvIntrospectorFromEnv } from "@lunora/bindings/kv";');
        expect(output).toContain("options.kvIntrospector = createKvIntrospectorFromEnv(env);");
    });

    it("does not hardcode a single `env.KV` binding — namespaces of any name light up", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasKv: true });

        expect(output).not.toContain("(env as Record<string, unknown>).KV");
        expect(output).not.toContain("namespaces: { KV:");
    });

    it("emits nothing KV-related when `ctx.kv` is not used", () => {
        expect.assertions(2);

        const output = emitApp(baseOptions);

        expect(output).not.toContain("@lunora/bindings/kv");
        expect(output).not.toContain("kvIntrospector");
    });
});
