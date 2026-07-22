/* eslint-disable no-secrets/no-secrets -- the assertions match emitted framework API names (e.g. "HyperdriveGlobalDeclaration<Env>"), not credentials. */
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
    hasImages: false,
    hasKv: false,
    hasNotify: false,
    hasPayments: false,
    hasQueue: false,
    hasR2sql: false,
    hasHyperdriveGlobal: false,
    hasScheduler: false,
    hasStorage: false,
    hasVectors: false,
    hasWorkflow: false,
    hasX402: false,
    useUmbrella: false,
    wantsOpenApi: false,
    wantsOpenRpc: false,
};

describe("emitApp — Hyperdrive global backend", () => {
    it("emits the .hyperdriveGlobal() builder method, declaration and config wiring", () => {
        expect.assertions(5);

        const output = emitApp({ ...baseOptions, hasHyperdriveGlobal: true });

        expect(output).toContain("public hyperdriveGlobal(declaration: HyperdriveGlobalDeclaration<Env>): this");
        expect(output).toContain("interface HyperdriveGlobalDeclaration<Env>");
        expect(output).toContain('import { createHyperdriveGlobalCtxDb } from "@lunora/hyperdrive/global";');
        expect(output).toContain("createHyperdriveGlobalCtxDb({");
        // It must NOT pull in the D1 `.global()` wiring when only Hyperdrive is used.
        expect(output).not.toContain("public global(declaration: GlobalDeclaration<Env>): this");
    });

    it("emits the D1 .global() wiring (not .hyperdriveGlobal()) for a D1-backed global app", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, hasGlobal: true });

        expect(output).toContain("public global(declaration: GlobalDeclaration<Env>): this");
        expect(output).not.toContain("createHyperdriveGlobalCtxDb");
    });

    it("imports the schema when only Hyperdrive globals are present", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, hasHyperdriveGlobal: true });

        expect(output).toContain('import schema from "../schema.js";');
    });

    it("wires options.workflowsClient (from CF env credentials) when the app declares workflows", () => {
        expect.assertions(4);

        const output = emitApp({ ...baseOptions, hasWorkflow: true });

        expect(output).toContain('import { createWorkflowsRestClient } from "@lunora/workflow";');
        expect(output).toContain("options.workflowsClient = (workflowEnv) =>");
        expect(output).toContain("createWorkflowsRestClient({ accountId, apiToken })");
        // No credentials wiring leaks into an app that declares no workflows.
        expect(emitApp(baseOptions)).not.toContain("options.workflowsClient");
    });
});
