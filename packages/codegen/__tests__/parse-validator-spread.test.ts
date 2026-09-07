/**
 * Spread resolution in an object shape.
 *
 * `.input({ ...sharedArgs, extra })` used to emit ONLY `extra`: the parser read
 * the literal syntactically and skipped every member that was not a property
 * assignment. Codegen exited 0 and said nothing, while the runtime validator
 * still enforced the fields behind the spread — so a caller passing `alpha` was
 * told the property does not exist, and a caller that satisfied the generated
 * type failed validation at runtime.
 */
import { Node, Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { parseObjectShape } from "../src/parse-validator";

let project: Project;

/** Parse the `args` object literal declared last in `source`. */
const shapeOf = (source: string): Record<string, unknown> => {
    project = new Project({ useInMemoryFileSystem: true });

    const file = project.createSourceFile("snippet.ts", source, { overwrite: true });
    const initializer = file.getVariableDeclarationOrThrow("args").getInitializerOrThrow();

    if (!Node.isObjectLiteralExpression(initializer)) {
        throw new Error("`args` must be an object literal");
    }

    return parseObjectShape(initializer);
};

describe("parseObjectShape spreads", () => {
    it("merges the fields a spread of a const object literal contributes", () => {
        expect.assertions(1);

        expect(shapeOf(`const shared = { alpha: v.string(), beta: v.optional(v.number()) };\nconst args = { ...shared, gamma: v.boolean() };`)).toStrictEqual({
            alpha: { kind: "string" },
            beta: { inner: { kind: "number" }, kind: "optional" },
            gamma: { kind: "boolean" },
        });
    });

    it("applies JS spread precedence — source order decides a collision", () => {
        expect.assertions(2);

        expect(shapeOf(`const shared = { id: v.string() };\nconst args = { ...shared, id: v.number() };`)).toStrictEqual({ id: { kind: "number" } });
        expect(shapeOf(`const shared = { id: v.string() };\nconst args = { id: v.number(), ...shared };`)).toStrictEqual({ id: { kind: "string" } });
    });

    it("follows a spread through a nested spread and an `as const`", () => {
        expect.assertions(1);

        const source =
            `const base = { alpha: v.string() };\n` +
            `const shared = { ...base, beta: v.number() } as const;\n` +
            `const args = { ...shared, gamma: v.boolean() };`;

        expect(shapeOf(source)).toStrictEqual({ alpha: { kind: "string" }, beta: { kind: "number" }, gamma: { kind: "boolean" } });
    });

    it("reports a spread it cannot resolve rather than dropping its fields", () => {
        expect.assertions(1);

        // Silence here is what made this expensive: the loss surfaced as a name
        // error at a caller in another package, reading as a typo rather than as
        // a dropped field.
        expect(() => shapeOf(`const args = { ...buildArgs(), gamma: v.boolean() };`)).toThrow(/cannot read the fields behind/u);
    });

    it("terminates on a mutually-referential spread instead of recursing forever", () => {
        expect.assertions(1);

        expect(() => shapeOf(`const a = { ...b };\nconst b = { ...a };\nconst args = { ...a };`)).toThrow(/cannot read the fields behind/u);
    });
});
