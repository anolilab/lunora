import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse as parseJsonc } from "jsonc-parser";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const parse = (path: string): ts.SourceFile => ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);

const propertyNames = (node: ts.ObjectLiteralExpression | ts.TypeLiteralNode): string[] =>
    node.kind === ts.SyntaxKind.TypeLiteral
        ? node.members.flatMap((member) => (member.name && ts.isIdentifier(member.name) ? [member.name.text] : []))
        : node.properties.flatMap((property) => (property.name && ts.isIdentifier(property.name) ? [property.name.text] : []));

const findFirst = <T extends ts.Node>(root: ts.Node, match: (node: ts.Node) => node is T): T | undefined => {
    let found: T | undefined;

    const visit = (node: ts.Node): void => {
        if (found) {
            return;
        }

        if (match(node)) {
            found = node;

            return;
        }

        ts.forEachChild(node, visit);
    };

    visit(root);

    return found;
};

/** The keys of `env` in the hand-written `cloudflare:workers` declaration. */
const declaredBindings = (): string[] => {
    const declaration = findFirst(
        parse("src/declarations.d.ts"),
        (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "env",
    );

    return declaration?.type && ts.isTypeLiteralNode(declaration.type) ? propertyNames(declaration.type).toSorted((a, b) => a.localeCompare(b)) : [];
};

/** The keys of the `bindings` object alchemy.run.ts deploys the Worker with. */
const deployedBindings = (): string[] => {
    const bindings = findFirst(
        parse("alchemy.run.ts"),
        (node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "bindings",
    );

    return bindings && ts.isObjectLiteralExpression(bindings.initializer) ? propertyNames(bindings.initializer).toSorted((a, b) => a.localeCompare(b)) : [];
};

/** Bindings `wrangler dev` provides: wrangler.jsonc's resources plus the secrets `.dev.vars.example` documents. */
const localBindings = (): string[] => {
    const config = parseJsonc(read("wrangler.jsonc")) as { kv_namespaces?: { binding: string }[]; ratelimits?: { name: string }[] };
    const secrets = read(".dev.vars.example")
        .split("\n")
        .flatMap((line) => /^([A-Z][A-Z0-9_]*)=/u.exec(line)?.[1] ?? []);

    return [...(config.kv_namespaces ?? []).map(({ binding }) => binding), ...(config.ratelimits ?? []).map(({ name }) => name), ...secrets].toSorted((a, b) =>
        a.localeCompare(b),
    );
};

// `env` is typed by hand (see src/declarations.d.ts), so nothing else stops it naming a
// binding the deployed or local Worker does not have.
describe("worker bindings", () => {
    it("declares exactly the bindings alchemy.run.ts deploys", () => {
        expect.assertions(2);

        expect(declaredBindings()).not.toHaveLength(0);
        expect(declaredBindings()).toStrictEqual(deployedBindings());
    });

    it("declares exactly the bindings wrangler dev provides", () => {
        expect.assertions(1);

        expect(declaredBindings()).toStrictEqual(localBindings());
    });
});
