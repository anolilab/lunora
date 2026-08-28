/**
 * How a feeder gets from a registration call to a body it can walk, and how it
 * recognises the database accessor once inside one.
 *
 * Everything that inspects handler bodies — the taint feeders, the raw-row and
 * normalize-id checks — starts at `procedureHandler`. When it returns
 * `undefined` the procedure is simply not analysed, so the boundary between
 * "inspectable" and "opaque" decides which code the security lints can see at
 * all.
 */
import { Node, Project, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { inlineHandler, isDatabaseAccessor, procedureHandler } from "../../../src/discover/functions/chain";

/**
 * The outermost call expression in `expression`.
 *
 * Each call gets its own in-memory project so nothing has to coordinate file
 * names or reset shared state between assertions.
 */
const callOf = (expression: string) =>
    new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true })
        .createSourceFile("case.ts", `const value = ${expression};`)
        .getFirstDescendantByKindOrThrow(SyntaxKind.CallExpression);

/** The receiver of `x` in `<x>.method(...)` — what a `ctx.db.query(...)` walk holds. */
const receiverOf = (expression: string): Node => {
    const callee = callOf(expression).getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        throw new TypeError(`not a method call: ${expression}`);
    }

    return callee.getExpression();
};

describe("procedureHandler", () => {
    it("reads the handler passed directly as the first argument", () => {
        expect.assertions(2);

        const arrow = procedureHandler(callOf("query(async (ctx) => ctx.db.query('m').collect())"));

        expect(arrow).toBeDefined();
        expect(Node.isArrowFunction(arrow)).toBe(true);
    });

    it("reads the handler off the object-literal `handler` property", () => {
        expect.assertions(2);

        const arrow = procedureHandler(callOf("query({ args: {}, handler: async (ctx) => ctx.db.query('m').collect() })"));

        expect(arrow).toBeDefined();
        expect(Node.isArrowFunction(arrow)).toBe(true);
    });

    it("accepts a function expression in either position", () => {
        expect.assertions(2);

        expect(Node.isFunctionExpression(procedureHandler(callOf("query(function (ctx) { return 1; })")))).toBe(true);
        expect(Node.isFunctionExpression(procedureHandler(callOf("query({ handler: function (ctx) { return 1; } })")))).toBe(true);
    });

    it("returns undefined for a handler that is not inline", () => {
        expect.assertions(3);

        // A handler defined elsewhere has no body here to walk. Every
        // body-inspecting feeder skips these — worth pinning, because it is the
        // reason a procedure written this way is invisible to the security
        // lints rather than reported as clean.
        expect(procedureHandler(callOf("query(sharedHandler)"))).toBeUndefined();
        expect(procedureHandler(callOf("query({ args: {}, handler: sharedHandler })"))).toBeUndefined();
        expect(procedureHandler(callOf("query({ args: {}, handler: wrap(sharedHandler) })"))).toBeUndefined();
    });

    it("returns undefined when there is no first argument and when it carries no handler", () => {
        expect.assertions(3);

        expect(procedureHandler(callOf("query()"))).toBeUndefined();
        expect(procedureHandler(callOf("query({ args: {} })"))).toBeUndefined();
        expect(procedureHandler(callOf("query('not-an-object')"))).toBeUndefined();
    });

    it("ignores a shorthand `handler` property, which carries no inline body", () => {
        expect.assertions(1);

        // `{ handler }` is a ShorthandPropertyAssignment, not a
        // PropertyAssignment — the value lives at the binding, not here.
        expect(procedureHandler(callOf("query({ handler })"))).toBeUndefined();
    });
});

describe("inlineHandler", () => {
    it("passes through arrows and function expressions, rejecting everything else", () => {
        expect.assertions(4);

        const argumentOf = (expression: string) => callOf(expression).getArguments()[0];

        expect(inlineHandler(argumentOf("f(() => 1)"))).toBeDefined();
        expect(inlineHandler(argumentOf("f(function () { return 1; })"))).toBeDefined();
        expect(inlineHandler(argumentOf("f(handler)"))).toBeUndefined();
        expect(inlineHandler(undefined)).toBeUndefined();
    });
});

describe("isDatabaseAccessor", () => {
    it("accepts `ctx.db` and a bare `db`", () => {
        expect.assertions(2);

        expect(isDatabaseAccessor(receiverOf("ctx.db.query('m')"))).toBe(true);
        expect(isDatabaseAccessor(receiverOf("db.query('m')"))).toBe(true);
    });

    it("rejects the system reader and other accessors on ctx", () => {
        expect.assertions(3);

        // `ctx.db.system.query(...)` has receiver `ctx.db.system`, whose member
        // name is `system` — the system reader is deliberately not the app db.
        expect(isDatabaseAccessor(receiverOf("ctx.db.system.query('m')"))).toBe(false);
        expect(isDatabaseAccessor(receiverOf("ctx.database.query('m')"))).toBe(false);
        expect(isDatabaseAccessor(receiverOf("ctx.storage.get(k)"))).toBe(false);
    });

    it("accepts a nested property access whose member is named db", () => {
        expect.assertions(1);

        expect(isDatabaseAccessor(receiverOf("outer.ctx.db.query('m')"))).toBe(true);
    });
});
