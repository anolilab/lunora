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
});
