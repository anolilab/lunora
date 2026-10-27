/**
 * The generated Workflow entrypoints for the privacy handlers. Codegen writes `_generated/workflows.ts`
 * from `lunora/workflows.ts`, and each entrypoint must bind the definition that wraps the package's
 * per-call handler, or a deployed workflow runs nothing. This reads the committed file, so a codegen
 * change that drops a binding, or swaps two, fails here before it reaches a deploy.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const GENERATED = readFileSync(new URL("../lunora/_generated/workflows.ts", import.meta.url), "utf8");

/** Each generated class declaration, with the text up to the next one. */
const CLASS_START = /(?=export class )/u;
/** The constructor call that binds a class to its definition and its step name. */
const BINDING = /super\(ctx, env, (\w+), "(\w+)"\);/u;

/** The definition and name the constructor of `className` binds, read from that class's own block only. */
const bindingOf = (className: string): { definition: string; name: string } | undefined => {
    const block = GENERATED.split(CLASS_START).find((chunk) => chunk.startsWith(`export class ${className} `));
    const match = BINDING.exec(block ?? "");

    return match === null ? undefined : { definition: match[1] ?? "", name: match[2] ?? "" };
};

describe("generated privacy workflows", () => {
    it.each([
        ["PrivacyErasureWorkflow", "privacyErasure"],
        ["PrivacyExportWorkflow", "privacyExport"],
        ["PrivacyRestoreWorkflow", "privacyRestore"],
    ])("binds %s to its own %s definition, inside its own class", (className, definition) => {
        expect.assertions(1);

        expect(bindingOf(className)).toStrictEqual({ definition, name: definition });
    });

    it("imports each definition from the app's workflows module, not from a copy", () => {
        expect.assertions(1);

        expect(GENERATED).toContain('import { privacyErasure, privacyExport, privacyRestore } from "../workflows.js";');
    });
});
