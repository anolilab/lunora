/**
 * Focused unit tests on `emitApi` — exercises return-type rendering rules
 * that don't depend on a full fixture project. The full happy-path is covered
 * by `runCodegen.test.ts`; this file targets edge cases like ts-morph's
 * `import("…")` qualifiers in inferred return types.
 */
import { describe, expect, it } from "vitest";

import { emitApi, emitFunctions } from "../src/emit";
import type { FunctionIR, WorkflowIR } from "../src/ir";

describe("emitApi", () => {
    it("emits a typed `workflows.*` reference object when the project declares workflows", () => {
        expect.assertions(5);

        const workflows: ReadonlyArray<WorkflowIR> = [
            { bindingName: "WORKFLOW_DIGEST_PIPELINE", className: "DigestPipelineWorkflow", exportName: "digestPipeline", name: "digest-pipeline" },
        ];

        const rendered = emitApi([], workflows);

        // Imports the workflow definitions so params can be inferred from `__params`.
        expect(rendered).toContain('import type * as lunoraWorkflowDefinitions from "../workflows.js";');
        // Typed reference carries the inferred params.
        // eslint-disable-next-line no-secrets/no-secrets -- generated TS generic, not a credential
        expect(rendered).toContain("digestPipeline: WorkflowReference<WorkflowParamsOf<typeof lunoraWorkflowDefinitions.digestPipeline>>;");
        // Runtime object carries the WORKFLOW_* binding + name.
        expect(rendered).toContain('digestPipeline: { isLunoraWorkflow: true, binding: "WORKFLOW_DIGEST_PIPELINE", name: "digestPipeline" },');
        expect(rendered).toContain("export const workflows: WorkflowsRef = {");
        expect(rendered).toContain("export interface WorkflowsRef {");
    });

    it("omits the `workflows` block entirely when no workflows are declared", () => {
        expect.assertions(2);

        const rendered = emitApi([]);

        expect(rendered).not.toContain("WorkflowsRef");
        expect(rendered).not.toContain("lunoraWorkflowDefinitions");
    });

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
                returnType: 'import("@lunora/server").LunoraContext',
            },
        ];

        const rendered = emitApi(functions);

        expect(rendered).toContain('import("@lunora/server").LunoraContext');
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

        // Regression: a handler nested in `lunora/sub/foo.ts` imports dataModel
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

    it("quotes a leading-digit namespace key so the emitted interface stays valid TS", () => {
        expect.assertions(3);

        // A file `lunora/2fa.ts` sanitizes to namespace `2fa` — a valid
        // `__lunoraRef` string but NOT a bare TS object key. The interface key
        // must be quoted (`"2fa": {...}`), while the runtime dispatch ref keeps
        // the raw `2fa:...` value (built by the `anyApi` proxy from the access
        // path), so type and runtime still agree.
        const functions: ReadonlyArray<FunctionIR> = [
            {
                args: {},
                exportName: "verify",
                filePath: "2fa",
                kind: "mutation",
                returnType: "boolean",
            },
        ];

        const rendered = emitApi(functions);

        expect(rendered).toContain('"2fa": {');
        expect(rendered).toContain('verify: FunctionReference<"mutation"');
        // Never emit `2fa` as a bare (invalid) object key.
        expect(rendered).not.toContain("    2fa: {");
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

    it("quotes a leading-digit namespace in both the Caller type and implementation", () => {
        expect.assertions(3);

        // `lunora/2fa.ts` → namespace `2fa`: the Caller interface key and the
        // implementation object key must both be quoted, but the dispatch ref
        // string passed to `callRegistered` keeps the raw `2fa:verify` value.
        const functions: ReadonlyArray<FunctionIR> = [
            {
                args: {},
                exportName: "verify",
                filePath: "2fa",
                kind: "mutation",
                returnType: "boolean",
            },
        ];

        const rendered = emitFunctions(functions);

        expect(rendered).toContain('"2fa": {');
        expect(rendered).toContain('callRegistered(context, "2fa:verify"');
        expect(rendered).not.toContain("    2fa: {");
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
