/**
 * The single gate deciding "is this a Lunora registration, and is it internal?"
 *
 * Every failure mode here is silent. Rejecting a real registration drops the
 * function from `LUNORA_FUNCTIONS` (calls 404) while codegen still exits `ok`;
 * accepting an unrelated `obj.query(...)` invents a route that no handler
 * backs. Both are invisible to the type checker, so the accept/reject boundary
 * is pinned directly rather than through whichever feeder happens to hit it.
 */
import type { CallExpression } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";
import { beforeEach, describe, expect, it } from "vitest";

import { classifyProcedureCall } from "../../../src/discover/functions/classify-procedure-call";

let project: Project;

/** The initializer call of the last `export const` in `body`. */
const classify = (body: string, imports = `import { query, mutation, internalQuery, onConnect } from "@lunora/server";`) => {
    const source = project.createSourceFile("messages.ts", `${imports}\n${body}`, { overwrite: true });
    const declarations = source.getVariableDeclarations();
    const initializer = declarations.at(-1)?.getInitializerIfKind(SyntaxKind.CallExpression);

    return classifyProcedureCall(initializer as CallExpression);
};

describe("classifyProcedureCall", () => {
    beforeEach(() => {
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    });

    it("classifies the bare-factory form as public, with no receiver", () => {
        expect.assertions(1);

        expect(classify(`export const list = query({ args: {}, handler: async () => [] });`)).toStrictEqual({ kind: "query", visibility: "public" });
    });

    it("marks the internal* factories internal and maps them to their kind", () => {
        expect.assertions(1);

        expect(classify(`export const list = internalQuery({ args: {}, handler: async () => [] });`)).toStrictEqual({
            kind: "query",
            visibility: "internal",
        });
    });

    it("tags a lifecycle factory as an internal mutation carrying its moment", () => {
        expect.assertions(1);

        expect(classify(`export const joined = onConnect(async () => null);`)).toStrictEqual({
            kind: "mutation",
            lifecycle: "connect",
            visibility: "internal",
        });
    });

    it("resolves an aliased import to the exported factory name, not the local alias", () => {
        expect.assertions(1);

        expect(classify(`export const list = q({ args: {}, handler: async () => [] });`, `import { query as q } from "@lunora/server";`)).toStrictEqual({
            kind: "query",
            visibility: "public",
        });
    });

    it("accepts all three module-specifier forms of the surface", () => {
        expect.assertions(3);

        const factory = `export const list = query({ args: {}, handler: async () => [] });`;

        expect(classify(factory, `import { query } from "@lunora/server";`)).toBeDefined();
        expect(classify(factory, `import { query } from "lunorash/server";`)).toBeDefined();
        expect(classify(factory, `import { query } from "./_generated/server";`)).toBeDefined();
    });

    it("rejects a factory imported from anywhere else", () => {
        expect.assertions(1);

        // The module gate is what stops an unrelated `query` helper becoming a
        // route; missing a legitimate form here is a silent drop, hence the
        // paired accept test above.
        expect(classify(`export const list = query({ args: {} });`, `import { query } from "some-other-package";`)).toBeUndefined();
    });

    it("rejects a locally declared factory of the same name", () => {
        expect.assertions(1);

        expect(
            classify(`const query = (config) => config;\nexport const list = query({ args: {} });`, `import { mutation } from "@lunora/server";`),
        ).toBeUndefined();
    });

    it("classifies a builder terminal and hands back the chain root as receiver", () => {
        expect.assertions(3);

        const classified = classify(`export const list = query.input(args).use(rls(p)).query(async () => []);`);

        expect(classified?.kind).toBe("query");
        expect(classified?.visibility).toBe("public");
        expect(classified?.receiver?.getText()).toBe("query.input(args).use(rls(p))");
    });

    it("carries visibility through a builder chain rooted at an internal factory", () => {
        expect.assertions(1);

        expect(classify(`export const list = internalQuery.use(m).query(async () => []);`)?.visibility).toBe("internal");
    });

    it("follows one hop through a local const bound to a partially applied builder", () => {
        expect.assertions(1);

        expect(classify(`const base = mutation.input(args);\nexport const send = base.mutation(async () => null);`)?.kind).toBe("mutation");
    });

    it("rejects a method call that merely shares a factory name", () => {
        expect.assertions(2);

        expect(classify(`export const rows = database.query("SELECT 1");`)).toBeUndefined();
        expect(classify(`export const list = query.input(args).select(async () => []);`)).toBeUndefined();
    });

    it("sees through the wrappers a chain can be dressed in", () => {
        expect.assertions(4);

        // None of these change what the expression evaluates to, but the chain
        // walk is structural, so each one used to end it early — and the whole
        // procedure was dropped from `LUNORA_FUNCTIONS` while codegen exited
        // `ok`. Not just its middleware: the registration itself vanished.
        expect(classify(`export const list = (query.use(rls(p))).query(async () => []);`)?.kind).toBe("query");
        expect(classify(`export const list = (query.use(rls(p)) as Builder).query(async () => []);`)?.kind).toBe("query");
        expect(classify(`export const list = (query.use(rls(p)) satisfies Builder).query(async () => []);`)?.kind).toBe("query");
        // A wrapper part-way along the chain, not just around the whole of it.
        expect(classify(`export const list = ((query.input(a) as Builder).use(rls(p))).query(async () => []);`)?.kind).toBe("query");
    });

    it("reads the brand off the wrapper when only the wrapper carries it", () => {
        expect.assertions(3);

        // `as T` and `!` are exactly the operators that NARROW, so the brand
        // often lives only on the wrapped type: unwrapping `(maybeBuilder as
        // Builder)` erases to `Builder | undefined`, whose `getProperty` finds
        // nothing because `undefined` has no members. Checking only the
        // unwrapped node dropped these registrations from `LUNORA_FUNCTIONS`.
        const builder = `interface B { __lunoraProcedure: true; query(h: unknown): unknown; }`;

        expect(classify(`${builder}\ndeclare const mb: B | undefined;\nexport const list = mb!.query(h);`, ``)?.kind).toBe("query");
        expect(classify(`${builder}\ndeclare const mb: B | null;\nexport const list = (mb as B).query(h);`, ``)?.kind).toBe("query");
        expect(classify(`${builder}\ndeclare const u: unknown;\nexport const list = (u as B).query(h);`, ``)?.kind).toBe("query");
    });

    it("does not let a cast downgrade an internal procedure to public", () => {
        expect.assertions(3);

        // Visibility is resolved across the wrapped AND unwrapped types with
        // `internal` winning. Reading it off whichever type answered the brand
        // let an assertion decide: `(internalBuilder as PublicBuilder)` came
        // back public, which publishes the procedure into the client-facing
        // `api` and opens it to client dispatch. A cast must not widen a
        // security classification.
        const builders = [
            `interface Pub { __lunoraProcedure: "query"; query(h: unknown): unknown }`,
            `interface Int { __lunoraProcedure: "query"; __lunoraVisibility: "internal"; query(h: unknown): unknown }`,
            `declare const b: Int;`,
        ].join("\n");

        expect(classify(`${builders}\nexport const list = b.query(h);`, ``)?.visibility).toBe("internal");
        expect(classify(`${builders}\nexport const list = (b as Pub).query(h);`, ``)?.visibility).toBe("internal");
        // The narrowing case the wrapper-first lookup exists for still works.
        expect(classify(`${builders}\ndeclare const m: Int | undefined;\nexport const list = m!.query(h);`, ``)?.visibility).toBe("internal");
    });

    it("hands back an unwrapped receiver so chain walkers can descend it", () => {
        expect.assertions(1);

        const classified = classify(`export const list = (query.use(rls(p)) as Builder).query(async () => []);`);

        expect(classified?.receiver?.getText()).toBe("query.use(rls(p))");
    });
});
