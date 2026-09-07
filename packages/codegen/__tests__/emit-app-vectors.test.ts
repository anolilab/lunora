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

describe("emitApp — vectors", () => {
    // `emitApp` normalises `hasVectors` to `hasVectors && vectorIndexCount > 0`,
    // which is the same conjunction the studio's nav flag reads — so the count
    // has to be set, not just the boolean, or nothing vector-related is emitted.
    it("wires the admin introspector when the schema declares an index", () => {
        expect.assertions(3);

        const output = emitApp({ ...baseOptions, hasVectors: true, vectorIndexCount: 1 });

        expect(output).toContain("createVectorAdminIntrospector");
        expect(output).toContain("options.vectorIntrospector = createVectorAdminIntrospector({");
        expect(output).toContain("registry: LUNORA_VECTOR_INDEXES,");
    });

    // The studio's Vectors flag is the same index count this emit is gated on, so
    // an app that declares an index and never binds it gets the tab plus a
    // `VECTORS_NOT_CONFIGURED` on every request — and a `ctx.vectors` that is the
    // throwing stub. `build()` can see the omission (`.vectors(...)` is a builder
    // call, not an `env` probe), so it says so there instead.
    it("refuses to build when an index is declared but no binding map was chained", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasVectors: true, vectorIndexCount: 1 });

        expect(output).toContain("if (this.shardExtras.vectors) {");
        expect(output).toContain(".vectors(): the schema declares vector index(es) but no binding map was chained.");
    });

    it("emits neither the introspector nor the guard when no index is declared", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasVectors: true, vectorIndexCount: 0 });

        expect(output).not.toContain("createVectorAdminIntrospector");
        expect(output).not.toContain(".vectors(): the schema declares vector index(es)");
    });
});
