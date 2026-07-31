/**
 * Focused unit tests on `emitApi` — exercises return-type rendering rules
 * that don't depend on a full fixture project. The full happy-path is covered
 * by `runCodegen.test.ts`; this file targets edge cases like ts-morph's
 * `import("…")` qualifiers in inferred return types.
 */
import { describe, expect, it } from "vitest";

import { emitApi, emitFunctions } from "../src/emit";
import type { AgentIR, FunctionIR, HttpRouteIR, WorkflowIR } from "../src/ir";

const SUPPORT_AGENT: AgentIR = {
    bindingName: "AGENT_SUPPORT",
    className: "SupportAgentWorkflow",
    exportName: "support",
    name: "agent-support",
};

/** A minimal `HttpRouteIR` with overridable fields, mirroring `openapi.test.ts`'s helper. */
const makeStreamRoute = (overrides: Partial<HttpRouteIR> = {}): HttpRouteIR => {
    return {
        body: {},
        exportName: "streamTokens",
        filePath: "http",
        method: "GET",
        params: {},
        path: "/api/tokens",
        searchParams: {},
        stream: true,
        ...overrides,
    };
};

describe("emitApi", () => {
    it("emits a typed `agents.*` scheduler-target reference object when the project declares agents", () => {
        expect.assertions(6);

        const rendered = emitApi({ agents: [SUPPORT_AGENT], functions: [] });

        // The flat AgentRunInput is imported (type-only) so `cronJobs()` args infer.
        expect(rendered).toContain('import type { AgentRunInput } from "@lunora/agent";');
        // The shared WorkflowReference interface backs the agent handle (an agent run is a workflow instance).
        expect(rendered).toContain("export interface WorkflowReference<Params = Record<string, unknown>> {");
        // Typed reference carries AgentRunInput.
        expect(rendered).toContain("support: WorkflowReference<AgentRunInput>;");
        // Runtime object carries the AGENT_* binding + stable name.
        expect(rendered).toContain('support: { isLunoraWorkflow: true, binding: "AGENT_SUPPORT", name: "agent-support" },');
        expect(rendered).toContain("export interface AgentsRef {");
        expect(rendered).toContain("export const agents: AgentsRef = {");
    });

    it("omits the `agents` block entirely when no agents are declared", () => {
        expect.assertions(3);

        const rendered = emitApi({ functions: [] });

        expect(rendered).not.toContain("AgentsRef");
        expect(rendered).not.toContain("AgentRunInput");
        // The shared WorkflowReference interface only appears when a workflow/agent exists.
        expect(rendered).not.toContain("WorkflowReference");
    });

    it("emits agent-free api output byte-identical to before the agents-ref emitter", () => {
        expect.assertions(2);

        // The agent handle is fully gated on a declared agent: passing `agents: []`
        // (or omitting it) must yield the exact same bytes as an agent-unaware call.
        const withEmptyAgents = emitApi({ agents: [], functions: [] });
        const withoutAgents = emitApi({ functions: [] });

        expect(withEmptyAgents).toBe(withoutAgents);
        expect(withEmptyAgents).not.toContain("agents");
    });

    it("emits ONE shared WorkflowReference interface when both workflows and agents are declared", () => {
        expect.assertions(4);

        const workflows: ReadonlyArray<WorkflowIR> = [
            { bindingName: "WORKFLOW_DIGEST_PIPELINE", className: "DigestPipelineWorkflow", exportName: "digestPipeline", name: "digest-pipeline", steps: [] },
        ];

        const rendered = emitApi({ agents: [SUPPORT_AGENT], functions: [], workflows });

        // The WorkflowReference interface is emitted exactly once (shared by both blocks).
        expect(rendered.match(/export interface WorkflowReference</gu)).toHaveLength(1);
        // Both reference objects are present.
        expect(rendered).toContain("export const workflows: WorkflowsRef = {");
        expect(rendered).toContain("export const agents: AgentsRef = {");
        // Both import lines are present.
        expect(rendered).toContain('import type * as lunoraWorkflowDefinitions from "../workflows.js";');
    });

    it("emits a typed `workflows.*` reference object when the project declares workflows", () => {
        expect.assertions(5);

        const workflows: ReadonlyArray<WorkflowIR> = [
            { bindingName: "WORKFLOW_DIGEST_PIPELINE", className: "DigestPipelineWorkflow", exportName: "digestPipeline", name: "digest-pipeline", steps: [] },
        ];

        const rendered = emitApi({ functions: [], workflows });

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

        const rendered = emitApi({ functions: [] });

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

        const rendered = emitApi({ functions });

        expect(rendered).toContain('import("./dataModel.js").Doc_channels[]');
        expect(rendered).not.toContain('import("./_generated/dataModel.js")');
    });

    it("renders a nested `v.optional()` as an optional property, not a required `T | undefined`", () => {
        expect.assertions(4);

        // A required key typed `T | undefined` obliges a caller to name every
        // field, so `{...args.patch}` spreads explicit `undefined`s into
        // `ctx.db.patch` — a partial update that is not partial. The handler
        // side already had the optionality; only the api emission dropped it.
        const functions: ReadonlyArray<FunctionIR> = [
            {
                args: {
                    // Nested inside v.object(...) — the reported failure.
                    patch: {
                        kind: "object",
                        shape: {
                            a: { inner: { kind: "string" }, kind: "optional" },
                            b: { inner: { kind: "number" }, kind: "optional" },
                            required: { kind: "string" },
                        },
                    },
                    // Top level — already correct, asserted so the two stay in step.
                    limit: { inner: { kind: "number" }, kind: "optional" },
                },
                exportName: "updateSettings",
                filePath: "settings",
                kind: "mutation",
                returnType: "null",
            },
        ];

        const rendered = emitApi({ functions });

        expect(rendered).toContain("a?: string");
        expect(rendered).toContain("b?: number");
        expect(rendered).toContain("required: string");
        expect(rendered).toContain("limit?: number");
    });

    it("renders a `v.optional()` nested inside `v.array(v.object(...))` as an optional property", () => {
        expect.assertions(2);

        // The same defect reached through an array element, which is how a
        // batch-insert argument hits it.
        const functions: ReadonlyArray<FunctionIR> = [
            {
                args: {
                    memories: {
                        inner: {
                            kind: "object",
                            shape: {
                                category: { inner: { kind: "string" }, kind: "optional" },
                                memory: { kind: "string" },
                            },
                        },
                        kind: "array",
                    },
                },
                exportName: "saveMemoryBatch",
                filePath: "memory",
                kind: "mutation",
                returnType: "null",
            },
        ];

        const rendered = emitApi({ functions });

        expect(rendered).toContain("category?: string");
        expect(rendered).toContain("memory: string");
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

        const rendered = emitApi({ functions });

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

        const rendered = emitApi({ functions });

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

        const rendered = emitApi({ functions });

        expect(rendered).toContain('import("./dataModel.js").Doc_messages[]');
        expect(rendered).not.toContain('import("../_generated/dataModel.js")');
    });

    it("adds the mandatory .js back to an extensionless generated qualifier", () => {
        expect.assertions(2);

        // A function file may import generated types without the extension
        // (`from "./_generated/dataModel"`) — the repo's own convention. ts-morph
        // prints the specifier verbatim, and an extensionless relative qualifier is
        // a TS2835 in `_generated/api.ts`, which is consumed under NodeNext.
        const functions: ReadonlyArray<FunctionIR> = [
            {
                args: {},
                exportName: "list",
                filePath: "messages",
                kind: "query",
                returnType: 'import("./_generated/dataModel").Doc_messages[]',
            },
        ];

        const rendered = emitApi({ functions });

        expect(rendered).toContain('import("./dataModel.js").Doc_messages[]');
        expect(rendered).not.toContain('import("./dataModel")');
    });

    it("rewrites base-package qualifiers to the umbrella subpath (and only for base packages)", () => {
        expect.assertions(4);

        // An umbrella-only app has no `@lunora/values` in its `package.json`, so a
        // checker-rendered `import("@lunora/values").Id<…>` — common when a mutator's
        // `server` impl returns `ctx.db.insert(...)` from a file that never imports
        // `Id` — is a TS2307 in the generated file. Add-ons stay scoped: they are
        // installed separately either way.
        const functions: ReadonlyArray<FunctionIR> = [
            {
                args: {},
                exportName: "insert",
                filePath: "messages",
                kind: "mutation",
                returnType: 'import("@lunora/values").Id<"messages">',
            },
            {
                args: {},
                exportName: "notify",
                filePath: "messages",
                kind: "mutation",
                returnType: 'import("@lunora/notify").Receipt',
            },
        ];

        const umbrella = emitApi({ functions, useUmbrella: true });

        expect(umbrella).toContain('import("lunorash/values").Id<"messages">');
        expect(umbrella).toContain('import("@lunora/notify").Receipt');

        const scoped = emitApi({ functions });

        expect(scoped).toContain('import("@lunora/values").Id<"messages">');
        expect(scoped).toContain('import("@lunora/notify").Receipt');
    });

    it("emits a typed api.mutators.<name> reference per custom mutator", () => {
        expect.assertions(4);

        // Finding #17 from the first third-party adoption: `serverRef` was an
        // unchecked string because `api.mutators.*` did not exist, so 23 client
        // mutators each restated `"mutators:insertSibling"` AND its arg type.
        const rendered = emitApi({
            functions: [],
            mutators: [
                { args: { text: { kind: "string" } }, exportName: "setText", filePath: "mutators", returnType: "{ ok: boolean }" },
                { args: {}, exportName: "clear", filePath: "mutators", returnType: "void" },
            ],
        });

        expect(rendered).toContain("    mutators: {");
        // Sorted by export name, regardless of discovery order.
        expect(rendered.indexOf("clear:")).toBeLessThan(rendered.indexOf("setText:"));
        expect(rendered).toContain('setText: FunctionReference<"mutation", { text: string }, { ok: boolean }>;');
        expect(rendered).toContain('clear: FunctionReference<"mutation", {}, void>;');
    });

    it("lets an app-registered function in mutators.ts win over a same-named mutator", () => {
        expect.assertions(2);

        // Both would render into the `mutators` namespace; a duplicate interface
        // member is invalid TS, so the discovered function is authoritative.
        const rendered = emitApi({
            functions: [{ args: {}, exportName: "setText", filePath: "mutators", kind: "query", returnType: "string" }],
            mutators: [{ args: { text: { kind: "string" } }, exportName: "setText", filePath: "mutators", returnType: "void" }],
        });

        expect(rendered).toContain('setText: FunctionReference<"query", {}, string>;');
        expect(rendered).not.toContain('setText: FunctionReference<"mutation"');
    });

    it("emits mutator-free api output byte-identical to a mutator-unaware call", () => {
        expect.assertions(1);

        expect(emitApi({ functions: [], mutators: [] })).toBe(emitApi({ functions: [] }));
    });

    it("imports FunctionReference only when the body references it", () => {
        expect.assertions(3);

        // The import used to be unconditional, so a project
        // with no discovered functions — including one where discovery had failed
        // and emitted an empty api — produced `_generated/api.ts` that fails
        // `tsc --noEmit` under `noUnusedLocals` with TS6133. That error points at
        // generated code the consumer cannot edit without losing type safety.
        const empty = emitApi({ functions: [] });

        expect(empty).not.toContain("FunctionReference");

        const populated = emitApi({ functions: [{ args: {}, exportName: "list", filePath: "todos", kind: "query", returnType: "string" }] });

        expect(populated).toContain('import type { FunctionReference } from "@lunora/client";');
        expect(populated).toContain('list: FunctionReference<"query", {}, string>;');
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

        const rendered = emitApi({ functions });

        expect(rendered).toContain('"2fa": {');
        expect(rendered).toContain('verify: FunctionReference<"mutation"');
        // Never emit `2fa` as a bare (invalid) object key.
        expect(rendered).not.toContain("    2fa: {");
    });

    it("emits a typed `httpStreams.*` reference block for `.stream()` routes", () => {
        expect.assertions(6);

        const httpRoutes: ReadonlyArray<HttpRouteIR> = [
            makeStreamRoute({
                chunkType: "{ text: string }",
                searchParams: { prompt: { kind: "string" } },
            }),
        ];

        const rendered = emitApi({ functions: [], httpRoutes });

        // The reference type comes from the client package (same source as
        // FunctionReference, which this fixture declares no functions for and so
        // does not import).
        expect(rendered).toContain('import type { HttpStreamRef } from "@lunora/client";');
        // Namespaced like `api.*`: file `http.ts` → `httpStreams.http.streamTokens`.
        expect(rendered).toContain("export interface HttpStreamsRef {");
        expect(rendered).toContain("streamTokens: HttpStreamRef<{ text: string }, { prompt: string }, {}>;");
        // The runtime object carries the verb + path the consumer opens.
        expect(rendered).toContain("export const httpStreams: HttpStreamsRef = {");
        expect(rendered).toContain('streamTokens: { method: "GET", path: "/api/tokens" },');
        expect(rendered).toContain("    http: {");
    });

    it("excludes non-stream routes and omits the block entirely when no `.stream()` route exists", () => {
        expect.assertions(3);

        const rendered = emitApi({ functions: [], httpRoutes: [makeStreamRoute({ stream: false })] });

        expect(rendered).not.toContain("HttpStreamsRef");
        expect(rendered).not.toContain("HttpStreamRef");
        // Nothing left to import from the client package, so the import line goes
        // away entirely rather than dangling (`noUnusedLocals` would flag it).
        expect(rendered).not.toContain('from "@lunora/client"');
    });

    it("renders a chunkType-less stream route as `unknown` and defaults empty validator maps to `{}`", () => {
        expect.assertions(1);

        const rendered = emitApi({ functions: [], httpRoutes: [makeStreamRoute()] });

        expect(rendered).toContain("streamTokens: HttpStreamRef<unknown, {}, {}>;");
    });

    it("relocates `_generated/` import qualifiers inside a stream chunk type", () => {
        expect.assertions(2);

        const rendered = emitApi({
            functions: [],
            httpRoutes: [makeStreamRoute({ chunkType: 'import("./_generated/dataModel.js").Doc_messages' })],
        });

        expect(rendered).toContain('import("./dataModel.js").Doc_messages');
        expect(rendered).not.toContain('import("./_generated/dataModel.js")');
    });

    it("imports the umbrella client specifier for httpStreams when useUmbrella is set", () => {
        expect.assertions(1);

        const rendered = emitApi({ functions: [], httpRoutes: [makeStreamRoute()], useUmbrella: true });

        expect(rendered).toContain('import type { HttpStreamRef } from "lunorash/client";');
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

        const rendered = emitApi({ functions });

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

        const rendered = emitFunctions({ functions });

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

        const rendered = emitFunctions({ functions });

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

        const rendered = emitFunctions({ functions });

        expect(rendered).toContain("list: (args?: {}) => Promise<string>;");
    });
});
