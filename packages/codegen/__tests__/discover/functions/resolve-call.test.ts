/**
 * The re-export resolver, pinned directly rather than through `discoverFunctions`.
 *
 * Two failure modes matter here and neither is visible to the type checker. If
 * the hop bound stops working, a cyclic or self-referential re-export
 * (`export const a = b; export const b = a`) recurses until the stack dies and
 * codegen crashes on a file that compiles fine. If a hop stops resolving, a
 * re-exported component function is silently dropped from `api.ts` and the call
 * 404s at runtime while codegen still exits `ok`.
 */
import type { CallExpression, VariableDeclaration } from "ts-morph";
import { Node, Project } from "ts-morph";
import { beforeEach, describe, expect, it } from "vitest";

import { exportCallsOfDeclaration, resolveExpressionToCall } from "../../../src/discover/functions/internal/resolve-call";

/** Enough of a factory for the checker; the resolver only cares that the node is a `CallExpression`. */
const PRELUDE = `declare const query: (config: unknown) => unknown;`;

const CALL = `query({ args: {}, handler: () => null })`;

let project: Project;

const sourceOf = (body: string) => project.createSourceFile("functions.ts", `${PRELUDE}\n${body}`, { overwrite: true });

/** The initializer expression of the named `const` in `body`. */
const initializerOf = (body: string, name: string): Node => sourceOf(body).getVariableDeclarationOrThrow(name).getInitializerOrThrow();

/** The last variable declaration in `body` — the one destructuring patterns hang off. */
const lastDeclarationOf = (body: string): VariableDeclaration => {
    const declarations = sourceOf(body).getVariableDeclarations();

    return declarations[declarations.length - 1] as VariableDeclaration;
};

/**
 * `c0 = query(...)`, then `hops` aliases on top of it, re-exported as `entry`.
 * Resolving `entry` costs one hop per alias plus one to step from the last
 * identifier onto the call itself.
 */
const aliasChain = (hops: number): string => {
    const lines = [`const c0 = ${CALL};`];

    for (let index = 1; index <= hops; index += 1) {
        lines.push(`const c${String(index)} = c${String(index - 1)};`);
    }

    lines.push(`export const entry = c${String(hops)};`);

    return lines.join("\n");
};

describe("resolveExpressionToCall", () => {
    beforeEach(() => {
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    });

    it("returns a call expression as-is", () => {
        expect.assertions(1);

        const initializer = initializerOf(`export const list = ${CALL};`, "list");

        expect(resolveExpressionToCall(initializer)).toBe(initializer);
    });

    it("follows an identifier through its const initializer to the call", () => {
        expect.assertions(1);

        const initializer = initializerOf(`const list = ${CALL};\nexport const alias = list;`, "alias");

        expect(resolveExpressionToCall(initializer)?.getText()).toBe(CALL);
    });

    it("unwraps parenthesized, as, satisfies and non-null wrappers", () => {
        expect.assertions(4);

        const body = `
            export const parens = (${CALL});
            export const asserted = ${CALL} as unknown;
            export const satisfied = ${CALL} satisfies unknown;
            export const bang = ${CALL}!;
        `;

        expect(resolveExpressionToCall(initializerOf(body, "parens"))?.getText()).toBe(CALL);
        expect(resolveExpressionToCall(initializerOf(body, "asserted"))?.getText()).toBe(CALL);
        expect(resolveExpressionToCall(initializerOf(body, "satisfied"))?.getText()).toBe(CALL);
        expect(resolveExpressionToCall(initializerOf(body, "bang"))?.getText()).toBe(CALL);
    });

    it("follows a property access into the object literal's property assignment", () => {
        expect.assertions(1);

        const body = `
            const bundle = { check: ${CALL} };
            const component = { functions: bundle };
            export const check = component.functions.check;
        `;

        expect(resolveExpressionToCall(initializerOf(body, "check"))?.getText()).toBe(CALL);
    });

    it("resolves through a shorthand property assignment", () => {
        expect.assertions(2);

        // The shorthand branch used to re-read `{ check }`'s own name node, and
        // TypeScript answers that identifier with the shorthand PROPERTY symbol
        // rather than the local `check` — so the walk landed back on the same
        // ShorthandPropertyAssignment and ping-ponged until the hop bound cut it
        // off. Only the bound stopped it recursing forever, and every function a
        // component bundled with shorthand was silently dropped from `api.ts`.
        const body = `
            const check = ${CALL};
            const bundle = { check };
            export const reExported = bundle.check;
        `;

        expect(resolveExpressionToCall(initializerOf(body, "reExported"))?.getText()).toBe(CALL);

        // Nested one level deeper, the shape a real component registry takes.
        const nested = `
            const check = ${CALL};
            const bundle = { check };
            const component = { functions: bundle };
            export const reExported = component.functions.check;
        `;

        expect(resolveExpressionToCall(initializerOf(nested, "reExported"))?.getText()).toBe(CALL);
    });

    it("resolves an alias chain that stays inside the hop bound", () => {
        expect.assertions(1);

        expect(resolveExpressionToCall(initializerOf(aliasChain(7), "entry"))?.getText()).toBe(CALL);
    });

    it("gives up on the alias chain one hop past the bound", () => {
        expect.assertions(1);

        // The call is still reachable — only the bound stops the walk, which is
        // what keeps a cycle from recursing forever.
        expect(resolveExpressionToCall(initializerOf(aliasChain(8), "entry"))).toBeUndefined();
    });

    it("terminates on a cyclic re-export instead of recursing forever", () => {
        expect.assertions(2);

        const body = `
            export const a = b;
            export const b = a;
        `;

        expect(() => resolveExpressionToCall(initializerOf(body, "a"))).not.toThrow();
        expect(resolveExpressionToCall(initializerOf(body, "a"))).toBeUndefined();
    });

    it("terminates on a self-referential re-export", () => {
        expect.assertions(1);

        expect(resolveExpressionToCall(initializerOf(`export const a = a;`, "a"))).toBeUndefined();
    });

    it("returns undefined for expressions that are not identifiers or property accesses", () => {
        expect.assertions(2);

        const body = `
            export const literal = 42;
            export const arrow = () => null;
        `;

        expect(resolveExpressionToCall(initializerOf(body, "literal"))).toBeUndefined();
        expect(resolveExpressionToCall(initializerOf(body, "arrow"))).toBeUndefined();
    });

    it("returns undefined for an identifier with no resolvable declaration", () => {
        expect.assertions(1);

        // The published-component case: the value lives behind an import with no
        // local call literal to reach.
        const body = `
            import { vendor } from "@vendor/ratelimit";
            export const check = vendor.functions.check;
        `;

        expect(resolveExpressionToCall(initializerOf(body, "check"))).toBeUndefined();
    });

    it("returns undefined when the declaration it lands on has no initializer", () => {
        expect.assertions(1);

        const body = `
            let pending;
            export const check = pending;
        `;

        expect(resolveExpressionToCall(initializerOf(body, "check"))).toBeUndefined();
    });
});

describe("exportCallsOfDeclaration", () => {
    beforeEach(() => {
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    });

    const names = (pairs: [string, CallExpression][]): string[] => pairs.map(([name]) => name);

    it("pairs a directly declared registration with its export name", () => {
        expect.assertions(2);

        const pairs = exportCallsOfDeclaration(lastDeclarationOf(`export const list = ${CALL};`));

        expect(names(pairs)).toStrictEqual(["list"]);
        expect(pairs[0]?.[1].getText()).toBe(CALL);
    });

    it("pairs a property-access re-export with the local export name", () => {
        expect.assertions(2);

        const pairs = exportCallsOfDeclaration(
            lastDeclarationOf(`
                const bundle = { check: ${CALL} };
                export const renamedCheck = bundle.check;
            `),
        );

        expect(names(pairs)).toStrictEqual(["renamedCheck"]);
        expect(pairs[0]?.[1].getText()).toBe(CALL);
    });

    it("yields one pair per element of a destructured re-export", () => {
        expect.assertions(2);

        const pairs = exportCallsOfDeclaration(
            lastDeclarationOf(`
                const bundle = { check: ${CALL}, reset: ${CALL} };
                export const { check, reset } = bundle;
            `),
        );

        expect(names(pairs)).toStrictEqual(["check", "reset"]);
        expect(pairs.every(([, call]) => Node.isCallExpression(call))).toBe(true);
    });

    it("keys a renamed destructured element by its local binding name", () => {
        expect.assertions(1);

        const pairs = exportCallsOfDeclaration(
            lastDeclarationOf(`
                const bundle = { check: ${CALL} };
                export const { check: rateLimitCheck } = bundle;
            `),
        );

        expect(names(pairs)).toStrictEqual(["rateLimitCheck"]);
    });

    it("keeps the resolvable elements and drops the rest", () => {
        expect.assertions(1);

        const pairs = exportCallsOfDeclaration(
            lastDeclarationOf(`
                const bundle = { check: ${CALL}, note: "not a registration" };
                export const { check, note } = bundle;
            `),
        );

        expect(names(pairs)).toStrictEqual(["check"]);
    });

    it("returns no pairs for a nested binding pattern", () => {
        expect.assertions(1);

        // The element's name node is another pattern, not an identifier, so it
        // fails safe rather than throwing on `element.getName()`.
        const pairs = exportCallsOfDeclaration(
            lastDeclarationOf(`
                const bundle = { nested: { check: ${CALL} } };
                export const { nested: { check } } = bundle;
            `),
        );

        expect(pairs).toStrictEqual([]);
    });

    it("returns no pairs for a declaration with no initializer", () => {
        expect.assertions(1);

        expect(exportCallsOfDeclaration(lastDeclarationOf(`export declare const check: unknown;`))).toStrictEqual([]);
    });

    it("returns no pairs when the initializer never reaches a call", () => {
        expect.assertions(1);

        expect(exportCallsOfDeclaration(lastDeclarationOf(`export const answer = 42;`))).toStrictEqual([]);
    });
});
