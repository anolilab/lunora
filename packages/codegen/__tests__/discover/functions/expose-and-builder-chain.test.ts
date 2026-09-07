/**
 * The two AST readers behind `discoverFromCall`: `expose.ts` (the `.expose(...)`
 * tag and the object-literal `args`) and `builder-chain.ts` (the `.input()` /
 * `.output()` chain walk plus return-type rendering).
 *
 * Both fail silently. A misread `.expose({ rest: true })` either publishes a
 * function on the REST surface that was never meant to be public, or drops one
 * that was — and neither shows up in the type checker. A dropped `.input()` key
 * takes its arg validator with it, so the runtime stops validating a field the
 * emitted types still promise. So the accept/reject boundary and the
 * "unreadable ⇒ omit rather than invent" rule are pinned directly here.
 */
import type { CallExpression, Node, PropertyAccessExpression } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";
import { beforeEach, describe, expect, it } from "vitest";

import {
    argsFromBuilderChain,
    outputFromBuilderChain,
    returnTypeFromBuilderCall,
    returnTypeFromCall,
} from "../../../src/discover/functions/internal/builder-chain";
import { argsFromCall, exposeFromBuilderChain } from "../../../src/discover/functions/internal/expose";

let project: Project;

/** The initializer call of the last `export const` in `body`. */
const lastCall = (body: string): CallExpression => {
    const source = project.createSourceFile("messages.ts", body, { overwrite: true });

    return source.getVariableDeclarations().at(-1)!.getInitializerIfKindOrThrow(SyntaxKind.CallExpression);
};

/**
 * The receiver `classifyProcedureCall` hands to the chain walkers: everything
 * left of the terminal `.query(...)` / `.mutation(...)`.
 */
const receiver = (body: string): Node => (lastCall(body).getExpression() as PropertyAccessExpression).getExpression();

describe("expose.ts", () => {
    beforeEach(() => {
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    });

    describe("argsFromCall", () => {
        it("reads the `args` object literal of the `{ args, handler }` form into validator IR", () => {
            expect.assertions(1);

            expect(
                argsFromCall(lastCall(`export const list = query({ args: { id: v.string(), limit: v.optional(v.number()) }, handler: () => [] });`)),
            ).toStrictEqual({
                id: { kind: "string" },
                limit: { inner: { kind: "number" }, kind: "optional" },
            });
        });

        it("returns no args when the call takes something other than an object literal", () => {
            expect.assertions(2);

            expect(argsFromCall(lastCall(`export const list = query(config);`))).toStrictEqual({});
            expect(argsFromCall(lastCall(`export const list = query();`))).toStrictEqual({});
        });

        it("returns no args when `args` is absent, shorthand, or a reference rather than a literal", () => {
            expect.assertions(3);

            // A shorthand (`{ args }`) or an indirection (`args: shared`) is not
            // statically readable. Reporting `{}` under-documents; inventing a shape
            // would type calls the runtime validator then rejects.
            expect(argsFromCall(lastCall(`export const list = query({ handler: () => [] });`))).toStrictEqual({});
            expect(argsFromCall(lastCall(`export const list = query({ args, handler: () => [] });`))).toStrictEqual({});
            expect(argsFromCall(lastCall(`export const list = query({ args: shared, handler: () => [] });`))).toStrictEqual({});
        });
    });

    describe("exposeFromBuilderChain", () => {
        it("finds `.expose({ rest: true })` several steps left of the terminal", () => {
            expect.assertions(1);

            expect(
                exposeFromBuilderChain(receiver(`export const list = query.expose({ rest: true }).input({ id: v.string() }).use(rls).query(h);`)),
            ).toStrictEqual({
                rest: true,
            });
        });

        it("returns undefined for a chain with no `.expose()` step", () => {
            expect.assertions(3);

            // Undefined (not `{}`) is what keeps a procedure RPC-only: `index.ts`
            // spreads `expose` into the IR only when it is defined.
            expect(exposeFromBuilderChain(receiver(`export const list = query.input({ id: v.string() }).query(h);`))).toBeUndefined();
            expect(exposeFromBuilderChain(receiver(`export const list = query.query(h);`))).toBeUndefined();
            expect(exposeFromBuilderChain(receiver(`export const list = query.input({}).output(v.string()).query(h);`))).toBeUndefined();
        });

        it("descends through a chain rooted at a call rather than an identifier", () => {
            expect.assertions(1);

            // `resolveBuilderRootKind` allows a factory-produced root; the walk must
            // reach `.expose()` before the non-property-access root stops it.
            expect(exposeFromBuilderChain(receiver(`export const list = makeQuery().expose({ rest: true }).query(h);`))).toStrictEqual({ rest: true });
        });

        it("takes the `.expose()` nearest the terminal — the last one written wins", () => {
            expect.assertions(1);

            // The walk runs terminal → root, so the rightmost step is seen first;
            // that matches the runtime, where each `.expose()` replaces the previous.
            expect(
                exposeFromBuilderChain(receiver(`export const list = query.expose({ rest: true }).input({}).expose({ rest: false }).query(h);`)),
            ).toStrictEqual({
                rest: false,
            });
        });

        it("treats an unreadable `.expose()` argument as exposed-but-unknown", () => {
            expect.assertions(3);

            // `{}` is truthy, so the function stays tagged; the missing `rest: true`
            // simply means it is not published — the safe direction to fail.
            expect(exposeFromBuilderChain(receiver(`export const list = query.expose(restConfig).query(h);`))).toStrictEqual({});
            expect(exposeFromBuilderChain(receiver(`export const list = query.expose().query(h);`))).toStrictEqual({});
            expect(exposeFromBuilderChain(receiver(`export const list = query.expose({ rest }).query(h);`))).toStrictEqual({});
        });

        it("resolves a computed `rest` to false rather than dropping the flag", () => {
            expect.assertions(1);

            // Only the literal `true` publishes. Anything the emitter cannot read as
            // `true` — a variable, an expression — is default-closed.
            expect(exposeFromBuilderChain(receiver(`export const list = query.expose({ rest: shouldExpose }).query(h);`))).toStrictEqual({ rest: false });
        });
    });

    describe("cache literal parsing", () => {
        it("reads every documented cache key off the literal", () => {
            expect.assertions(1);

            const chain = `export const list = query.expose({ cache: { maxAge: 60, scope: "public", staleWhileRevalidate: 120, tag: "messages", vary: "Accept-Language" }, rest: true }).query(h);`;

            expect(exposeFromBuilderChain(receiver(chain))).toStrictEqual({
                cache: { maxAge: 60, scope: "public", staleWhileRevalidate: 120, tag: "messages", vary: "Accept-Language" },
                rest: true,
            });
        });

        it("records a cache block even when `rest` is absent", () => {
            expect.assertions(1);

            expect(exposeFromBuilderChain(receiver(`export const list = query.expose({ cache: { scope: "private" } }).query(h);`))).toStrictEqual({
                cache: { scope: "private" },
            });
        });

        it("omits keys that are not literals of the expected type", () => {
            expect.assertions(2);

            // A computed `maxAge` and a string `staleWhileRevalidate` are dropped
            // rather than guessed, so the emitted spec under-documents instead of
            // stating a `Cache-Control` the runtime will not send.
            expect(exposeFromBuilderChain(receiver(`export const list = query.expose({ cache: { maxAge: ttl, tag: "messages" } }).query(h);`))).toStrictEqual({
                cache: { tag: "messages" },
            });
            expect(
                exposeFromBuilderChain(receiver(`export const list = query.expose({ cache: { maxAge: 60, staleWhileRevalidate: "120" } }).query(h);`)),
            ).toStrictEqual({ cache: { maxAge: 60 } });
        });

        it("drops a `scope` outside the private/public union", () => {
            expect.assertions(1);

            expect(exposeFromBuilderChain(receiver(`export const list = query.expose({ cache: { maxAge: 60, scope: "edge" } }).query(h);`))).toStrictEqual({
                cache: { maxAge: 60 },
            });
        });

        it("reports a cache block with nothing readable as absent, not as an empty object", () => {
            expect.assertions(3);

            // "Unreadable" must not be mistakable for "declared with no options".
            expect(exposeFromBuilderChain(receiver(`export const list = query.expose({ cache: { maxAge: ttl, scope: chosen } }).query(h);`))).toStrictEqual({});
            expect(exposeFromBuilderChain(receiver(`export const list = query.expose({ cache: {} }).query(h);`))).toStrictEqual({});
            expect(exposeFromBuilderChain(receiver(`export const list = query.expose({ cache: sharedCache, rest: true }).query(h);`))).toStrictEqual({
                rest: true,
            });
        });
    });
});

describe("builder-chain.ts", () => {
    beforeEach(() => {
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    });

    describe("argsFromBuilderChain", () => {
        it("merges every `.input()` in the chain, the last written winning a collision", () => {
            expect.assertions(1);

            const chain = `export const list = query.input({ id: v.number(), keep: v.boolean() }).use(rls).input({ id: v.string() }).query(h);`;

            expect(argsFromBuilderChain(receiver(chain))).toStrictEqual({ id: { kind: "string" }, keep: { kind: "boolean" } });
        });

        it("skips an `.input()` whose argument is not an object literal", () => {
            expect.assertions(1);

            expect(argsFromBuilderChain(receiver(`export const list = query.input(sharedArgs).input({ id: v.string() }).query(h);`))).toStrictEqual({
                id: { kind: "string" },
            });
        });

        it("returns an empty record for a chain with no `.input()`", () => {
            expect.assertions(2);

            expect(argsFromBuilderChain(receiver(`export const list = query.use(rls).query(h);`))).toStrictEqual({});
            expect(argsFromBuilderChain(receiver(`export const list = query.query(h);`))).toStrictEqual({});
        });

        it("still collects an `.input()` on a chain rooted at a call expression", () => {
            expect.assertions(1);

            expect(argsFromBuilderChain(receiver(`export const list = makeQuery().input({ id: v.string() }).query(h);`))).toStrictEqual({
                id: { kind: "string" },
            });
        });
    });

    describe("outputFromBuilderChain", () => {
        it("parses the `.output(validator)` argument", () => {
            expect.assertions(1);

            expect(outputFromBuilderChain(receiver(`export const list = query.input({}).output(v.object({ count: v.number() })).query(h);`))).toStrictEqual({
                kind: "object",
                shape: { count: { kind: "number" } },
            });
        });

        it("takes the `.output()` nearest the terminal — each one replaces the previous at runtime", () => {
            expect.assertions(1);

            expect(outputFromBuilderChain(receiver(`export const list = query.output(v.string()).output(v.number()).query(h);`))).toStrictEqual({
                kind: "number",
            });
        });

        it("returns undefined when there is no `.output()`, or it was called with no argument", () => {
            expect.assertions(2);

            expect(outputFromBuilderChain(receiver(`export const list = query.input({ id: v.string() }).query(h);`))).toBeUndefined();
            expect(outputFromBuilderChain(receiver(`export const list = query.output().query(h);`))).toBeUndefined();
        });
    });

    describe("returnTypeFromCall", () => {
        it("renders the handler's return type, unwrapping the awaited Promise", () => {
            expect.assertions(2);

            expect(returnTypeFromCall(lastCall(`export const list = query({ args: {}, handler: async () => ({ n: 1 }) });`))).toBe("{ n: number; }");
            expect(returnTypeFromCall(lastCall(`export const list = query({ args: {}, handler: function () { return "hi"; } });`))).toBe("string");
        });

        it("falls back to unknown when there is no readable inline handler", () => {
            expect.assertions(4);

            // Each of these is a real authoring shape; none is an error, so the only
            // honest answer is `unknown` rather than a type nobody can back up.
            expect(returnTypeFromCall(lastCall(`export const list = query(config);`))).toBe("unknown");
            expect(returnTypeFromCall(lastCall(`export const list = query({ args: {} });`))).toBe("unknown");
            expect(returnTypeFromCall(lastCall(`export const list = query({ args: {}, handler: listHandler });`))).toBe("unknown");
            expect(returnTypeFromCall(lastCall(`export const list = query({ args: {}, handler });`))).toBe("unknown");
        });
    });

    describe("returnTypeFromBuilderCall", () => {
        it("reads the handler from the first argument, not from a `handler:` property", () => {
            expect.assertions(1);

            expect(returnTypeFromBuilderCall(lastCall(`export const list = query.input({}).query(() => ({ ok: true }));`))).toBe("{ ok: boolean; }");
        });

        it("falls back to unknown when the terminal has no inline function argument", () => {
            expect.assertions(2);

            expect(returnTypeFromBuilderCall(lastCall(`export const list = query.input({}).query(listHandler);`))).toBe("unknown");
            expect(returnTypeFromBuilderCall(lastCall(`export const list = query.input({}).query();`))).toBe("unknown");
        });

        it("does not read the object-literal form — the two entry points are not interchangeable", () => {
            expect.assertions(2);

            // Feeding the wrong reader a `{ args, handler }` literal must not
            // accidentally work; `index.ts` picks between them on `classified.receiver`.
            const objectLiteralForm = `export const list = query({ args: {}, handler: async () => 1 });`;

            expect(returnTypeFromBuilderCall(lastCall(objectLiteralForm))).toBe("unknown");
            expect(returnTypeFromCall(lastCall(objectLiteralForm))).toBe("number");
        });
    });
});
