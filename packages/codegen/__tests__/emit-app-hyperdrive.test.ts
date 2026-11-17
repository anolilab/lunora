/* eslint-disable no-secrets/no-secrets -- the assertions match emitted framework API names (e.g. "HyperdriveGlobalDeclaration<Env>"), not credentials. */
import { describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";
import baseOptions from "./emit-app-options";

describe("emitApp — Hyperdrive global backend", () => {
    it("emits the .hyperdriveGlobal() builder method, declaration and config wiring", () => {
        expect.assertions(5);

        const output = emitApp({ ...baseOptions, hasHyperdriveGlobal: true });

        expect(output).toContain("public hyperdriveGlobal(declaration: HyperdriveGlobalDeclaration<Env>): this");
        expect(output).toContain("interface HyperdriveGlobalDeclaration<Env>");
        expect(output).toContain(
            'import { applyHyperdriveGlobalCdc, createHyperdriveGlobalCtxDb, createHyperdriveGlobalIntrospector, exportHyperdriveGlobalRows, importHyperdriveGlobalRows, readHyperdriveGlobalCdc } from "@lunora/hyperdrive/global";',
        );
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

    it("wires the whole admin global plane for a Hyperdrive-only worker", () => {
        expect.assertions(8);

        const output = emitApp({ ...baseOptions, hasHyperdriveGlobal: true });

        // Without these the admin import refuses every global row (GLOBAL_NOT_CONFIGURED),
        // export and backups silently drop them, and CDC sync / PITR apply see no global plane.
        expect(output).toContain("options.importGlobals = (request) =>");
        expect(output).toContain("importHyperdriveGlobalRows({");
        expect(output).toContain("options.importGlobalsSupportsDryRun = true;");
        expect(output).toContain("options.importGlobalsSupportsReplace = true;");
        expect(output).toContain("options.exportGlobals = (request) => exportHyperdriveGlobalRows(");
        expect(output).toContain("options.globalIntrospector = {");
        expect(output).toContain("options.syncGlobals = async (request) =>");
        expect(output).toContain("options.applyGlobals = (request) =>");
    });

    it("builds the Hyperdrive exec inside each admin request, never once per options build", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, hasHyperdriveGlobal: true });

        // A pg/MySQL socket opened while serving one request cannot do I/O for another on Workers.
        expect(output).toContain("const exec = (): SqlExec => hyperdriveDeclaration.exec(env);");
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
