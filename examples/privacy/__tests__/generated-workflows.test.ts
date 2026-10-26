/**
 * The generated Workflow entrypoints for the privacy handlers. Codegen writes `_generated/workflows.ts`
 * from `lunora/workflows.ts`, and each entrypoint must bind the definition that wraps the package's
 * per-call handler, or a deployed workflow runs nothing. This reads the committed file, so a codegen
 * change that drops a binding fails here before it reaches a deploy.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const GENERATED = readFileSync(new URL("../lunora/_generated/workflows.ts", import.meta.url), "utf8");

describe("generated privacy workflows", () => {
    it.each([
        ["PrivacyErasureWorkflow", "privacyErasure", "privacyErasure"],
        ["PrivacyExportWorkflow", "privacyExport", "privacyExport"],
        ["PrivacyRestoreWorkflow", "privacyRestore", "privacyRestore"],
    ])("emits %s bound to the %s definition", (className, definition, name) => {
        expect.assertions(2);

        expect(GENERATED).toContain(`export class ${className} extends LunoraWorkflow<`);
        expect(GENERATED).toContain(`super(ctx, env, ${definition}, "${name}");`);
    });

    it("imports each definition from the app's workflows module, not from a copy", () => {
        expect.assertions(1);

        expect(GENERATED).toContain('import { privacyErasure, privacyExport, privacyRestore } from "../workflows.js";');
    });
});
