/**
 * Focused unit tests on `emitApi` — exercises return-type rendering rules
 * that don't depend on a full fixture project. The full happy-path is covered
 * by `runCodegen.test.ts`; this file targets edge cases like ts-morph's
 * `import("…")` qualifiers in inferred return types.
 */
import { describe, expect, it } from "vitest";

import { emitApi, emitFunctions } from "../src/emit";
import type { FunctionIR } from "../src/ir";

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

    it("rewrites `../_generated/X` qualifiers from nested function files", () => {
        expect.assertions(2);

        // Regression: a handler nested in `cirrus/sub/foo.ts` imports dataModel
        // via `../_generated/dataModel.js`; ts-morph prints that relative path
        // verbatim. Inlined into `_generated/api.ts` it must collapse to
        // `./dataModel.js`, not stay `../_generated/...` (which resolves one
        // directory too high → tsc TS2307).
        const functions: ReadonlyArray<FunctionIR> = [
            {
                args: {},
                exportName: "list",
                filePath: "sub/foo",
                kind: "query",
                returnType: 'import("../_generated/dataModel.js").Doc_messages[]',
            },
        ];

        const rendered = emitApi(functions);

        expect(rendered).toContain('import("./dataModel.js").Doc_messages[]');
        expect(rendered).not.toContain('import("../_generated/dataModel.js")');
    });

    it("rewrites deeply nested `../../_generated/X` qualifiers", () => {
        expect.assertions(2);

        const functions: ReadonlyArray<FunctionIR> = [
            {
                args: {},
                exportName: "list",
                filePath: "a/b/foo",
                kind: "query",
                returnType: 'import("../../_generated/dataModel.js").Doc_messages[]',
            },
        ];

        const rendered = emitApi(functions);

        expect(rendered).toContain('import("./dataModel.js").Doc_messages[]');
        expect(rendered).not.toContain('_generated/dataModel.js");');
    });
});

describe("emitFunctions Caller types", () => {
    it("types a `stream` leaf as resolving to `AsyncIterable<T>`, not a single element", () => {
        expect.assertions(2);

        // A stream handler returns an `AsyncIterable<T>` synchronously; the
        // Caller awaits it through `callRegistered`, so the leaf resolves to
        // a wrapped async iterable, not a single element.
        const functions: ReadonlyArray<FunctionIR> = [
            {
                args: {},
                exportName: "watch",
                filePath: "messages",
                kind: "stream",
                returnType: "string",
            },
        ];

        const rendered = emitFunctions(functions);

        // eslint-disable-next-line no-secrets/no-secrets -- asserting on a generated TS type string, not a secret
        expect(rendered).toContain("watch: (args?: {}) => Promise<AsyncIterable<string>>;");
        expect(rendered).not.toContain("watch: (args?: {}) => Promise<string>;");
    });

    it("keeps non-stream leaves typed as `Promise<T>`", () => {
        expect.assertions(1);

        const functions: ReadonlyArray<FunctionIR> = [
            {
                args: {},
                exportName: "list",
                filePath: "messages",
                kind: "query",
                returnType: "string",
            },
        ];

        const rendered = emitFunctions(functions);

        expect(rendered).toContain("list: (args?: {}) => Promise<string>;");
    });
});
