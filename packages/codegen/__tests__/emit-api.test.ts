/**
 * Focused unit tests on `emitApi` — exercises return-type rendering rules
 * that don't depend on a full fixture project. The full happy-path is covered
 * by `runCodegen.test.ts`; this file targets edge cases like ts-morph's
 * `import("…")` qualifiers in inferred return types.
 */
import { describe, expect, it } from "vitest";

import { emitApi } from "../src/emit.js";
import type { FunctionIR } from "../src/ir.js";

describe("emitApi", () => {
    it("rewrites `import('./_generated/X')` qualifiers to `import('./X')` so paths resolve inside _generated/", () => {
        expect.assertions(2);

        // Regression: when a handler returns a type from `_generated/dataModel`,
        // ts-morph prints `import("./_generated/dataModel.js").Doc_channels`
        // — correct from the function file, but tsc rejects it from inside
        // `_generated/api.ts` (which IS `_generated/`).
        const functions: ReadonlyArray<FunctionIR> = [
            {
                args: {},
                exportName: "list",
                filePath: "channels",
                kind: "query",
                returnType: 'import("./_generated/dataModel.js").Doc_channels[]',
            },
        ];

        const rendered = emitApi(functions);

        expect(rendered).toContain('import("./dataModel.js").Doc_channels[]');
        expect(rendered).not.toContain('import("./_generated/dataModel.js")');
    });

    it("leaves absolute `import('@scope/pkg')` qualifiers untouched", () => {
        expect.assertions(1);

        const functions: ReadonlyArray<FunctionIR> = [
            {
                args: {},
                exportName: "getCtx",
                filePath: "ctx",
                kind: "query",
                returnType: 'import("@cirrus/server").CirrusContext',
            },
        ];

        const rendered = emitApi(functions);

        expect(rendered).toContain('import("@cirrus/server").CirrusContext');
    });

    it("rewrites the `_generated/` prefix even without a leading `./`", () => {
        expect.assertions(2);

        const functions: ReadonlyArray<FunctionIR> = [
            {
                args: {},
                exportName: "list",
                filePath: "messages",
                kind: "query",
                returnType: 'import("_generated/dataModel.js").Doc_messages[]',
            },
        ];

        const rendered = emitApi(functions);

        expect(rendered).toContain('import("./dataModel.js").Doc_messages[]');
        expect(rendered).not.toContain('import("_generated/dataModel.js")');
    });
});
