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
    hasPayments: false,
    hasQueue: false,
    hasR2sql: false,
    hasScheduler: false,
    hasStorage: false,
    hasVectors: false,
    hasWorkflow: false,
    useUmbrella: false,
    wantsOpenApi: false,
    wantsOpenRpc: false,
};

describe("emitApp — KV introspector wiring", () => {
    it("wires the studio KV browser off `env.KV` when `ctx.kv` is used", () => {
        expect.assertions(4);

        const output = emitApp({ ...baseOptions, hasKv: true });

        expect(output).toContain('import { createKvIntrospector } from "@lunora/bindings/kv";');
        expect(output).toContain('import type { KVNamespaceLike } from "@lunora/bindings/kv";');
        expect(output).toContain("const kvNamespace = (env as Record<string, unknown>).KV;");
        expect(output).toContain("options.kvIntrospector = createKvIntrospector({ namespaces: { KV: kvNamespace as KVNamespaceLike } });");
    });

    it("guards the wiring on binding presence so a KV-less deployment does not crash", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, hasKv: true });

        expect(output).toContain("if (kvNamespace) {");
    });

    it("emits nothing KV-related when `ctx.kv` is not used", () => {
        expect.assertions(2);

        const output = emitApp(baseOptions);

        expect(output).not.toContain("@lunora/bindings/kv");
        expect(output).not.toContain("kvIntrospector");
    });
});
