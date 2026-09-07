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
    hasKvIntrospector: false,
    hasNotify: false,
    hasPayments: false,
    hasQueue: false,
    hasR2sql: false,
    hasScheduler: false,
    hasStorage: false,
    hasVectors: false,
    hasWorkflow: false,
    hasX402: false,
    tableNames: [],
    useUmbrella: false,
    wantsOpenApi: false,
    wantsOpenRpc: false,
};

describe("emitApp — KV introspector wiring", () => {
    /* eslint-disable no-secrets/no-secrets -- false positive: `ShardConfig["kv"]` is emitted TypeScript asserted below, not a credential. */
    // The blog example: `@lunora/bindings` is a declared dependency (so the studio
    // KV tab fails open and the introspector is wired) but `ctx.kv` is never used
    // (so `ShardDOConfig` carries no `kv` field). Emitting the `.kv()` builder here
    // produced `NonNullable<ShardConfig["kv"]>` against a type without that
    // property — TS2339, in committed generated code.
    it("does not emit the `.kv()` builder when only the introspector is wired", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasKv: false, hasKvIntrospector: true });

        expect(output).toContain("options.kvIntrospector = createKvIntrospectorFromEnv(env);");
        expect(output).not.toContain('ShardConfig["kv"]');
    });
    /* eslint-enable no-secrets/no-secrets */

    it("wires the studio KV browser by scanning `env` for every KV namespace when `ctx.kv` is used", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasKvIntrospector: true });

        expect(output).toContain('import { createKvIntrospectorFromEnv } from "@lunora/bindings/kv";');
        expect(output).toContain("options.kvIntrospector = createKvIntrospectorFromEnv(env);");
    });

    it("does not hardcode a single `env.KV` binding — namespaces of any name light up", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasKvIntrospector: true });

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
