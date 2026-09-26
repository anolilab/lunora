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
    hasSourcedTables: false,
    hasStorage: false,
    hasVectors: false,
    hasWorkflow: false,
    hasX402: false,
    tableNames: [],
    useUmbrella: false,
    wantsOpenApi: false,
    wantsOpenRpc: false,
};

describe("emitApp — schema jurisdiction", () => {
    it("omits the jurisdiction option when not declared (default)", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions });

        expect(output).not.toContain("jurisdiction:");
    });

    it("emits jurisdiction into the createWorker options when declared", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, jurisdiction: "us" });

        expect(output).toContain('jurisdiction: "us",');
    });

    it("pins ctx.scheduler to the jurisdiction when the app uses the scheduler", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, hasScheduler: true, jurisdiction: "eu" });

        expect(output).toContain('createScheduler({ jurisdiction: "eu", namespace })');
    });

    it("leaves ctx.scheduler un-pinned when no jurisdiction is declared", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, hasScheduler: true });

        expect(output).toContain("createScheduler({ namespace })");
    });

    it("pins the DO-backed auth object once the move is acknowledged", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, hasAuth: true, jurisdiction: "eu", jurisdictionPinsAuth: true });
        const wiring = /createDoAuthWiring\(\{[\s\S]*?\}\);/u.exec(output)?.[0] ?? "";

        expect(wiring.match(/jurisdiction: "eu",/gu)).toHaveLength(1);
    });

    it("keeps the DO-backed auth object where its data is until the move is acknowledged", () => {
        expect.assertions(1);

        // Pinning would resolve every user to a NEW, EMPTY auth object.
        const output = emitApp({ ...baseOptions, hasAuth: true, jurisdiction: "eu" });
        const wiring = /createDoAuthWiring\(\{[\s\S]*?\}\);/u.exec(output)?.[0] ?? "";

        expect(wiring).not.toContain("jurisdiction");
    });

    it("leaves the DO-backed auth object un-pinned when no jurisdiction is declared", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasAuth: true });
        const wiring = /createDoAuthWiring\(\{[\s\S]*?\}\);/u.exec(output)?.[0] ?? "";

        expect(wiring).toContain("namespace: authNamespace(env),");
        expect(wiring).not.toContain("jurisdiction");
    });
});
