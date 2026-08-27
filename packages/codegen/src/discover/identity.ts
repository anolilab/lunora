import { existsSync } from "node:fs";
import { join } from "node:path";

import type { CallExpression, Identifier, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "./diagnostics";
import type { IdentityIR } from "./ir";
import { isServerPackageModule } from "./module-specifiers";

/** The only file a `defineIdentity` contract may be declared in — mirrors `lunora/shapes.ts`. */
const IDENTITY_FILENAME = "identity.ts";

/**
 * Decide whether a callee identifier refers to `defineIdentity` from
 * `@lunora/server` (or its `lunorash/server` umbrella subpath). Mirrors
 * `isDefineShape`: trust the import declaration when the checker has a symbol
 * (so aliasing survives), and fall back to the surface text when no symbol is
 * available.
 */
const isDefineIdentity = (identifier: Identifier): boolean => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return identifier.getText() === "defineIdentity";
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        if (!isServerPackageModule(declaration.getImportDeclaration().getModuleSpecifierValue())) {
            return false;
        }

        return declaration.getNameNode().getText() === "defineIdentity";
    }

    return false;
};

/**
 * Decide whether `identifier` is a namespace binding of an allowed identity
 * module — the `server` in `import * as server from "@lunora/server"`. Used to
 * recognize the member-access callee form `server.defineIdentity(...)`.
 */
const isIdentityNamespaceImport = (identifier: Identifier): boolean => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return false;
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isNamespaceImport(declaration)) {
            continue;
        }

        const importDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);

        return importDeclaration !== undefined && isServerPackageModule(importDeclaration.getModuleSpecifierValue());
    }

    return false;
};

/**
 * Decide whether a call's callee is `defineIdentity` — either the bare imported
 * identifier (`defineIdentity(...)`) or a namespace member access
 * (`server.defineIdentity(...)`). Both are valid ES module syntax, so discovery
 * must see the contract declared either way.
 */
const isDefineIdentityCallee = (callee: TsNode): boolean => {
    if (Node.isIdentifier(callee)) {
        return isDefineIdentity(callee);
    }

    if (Node.isPropertyAccessExpression(callee)) {
        const object = callee.getExpression();

        return callee.getName() === "defineIdentity" && Node.isIdentifier(object) && isIdentityNamespaceImport(object);
    }

    return false;
};

/** Collect exported `defineIdentity` declarations from one source file. */
const identitiesFromSource = (source: SourceFile): IdentityIR[] => {
    const identities: IdentityIR[] = [];

    for (const declaration of source.getVariableDeclarations()) {
        if (!declaration.isExported()) {
            continue;
        }

        const initializer = declaration.getInitializer();

        if (initializer?.getKind() !== SyntaxKind.CallExpression) {
            continue;
        }

        const callExpression = initializer as CallExpression;

        if (!isDefineIdentityCallee(callExpression.getExpression())) {
            continue;
        }

        const nameNode = declaration.getNameNode();

        if (!Node.isIdentifier(nameNode)) {
            throw diagnosticAt(nameNode, "defineIdentity exports must be plain named exports (no destructuring)");
        }

        identities.push({ exportName: nameNode.getText() });
    }

    return identities;
};

/**
 * Discover the single identity claim contract the project declares: the
 * exported `defineIdentity()` call in `lunora/identity.ts`. Returns `undefined`
 * when the file doesn't exist — so a project without one emits byte-identical
 * generated code. Only the export binding is lifted; the emitted server type
 * recovers the claim shape from the declaration itself (`InferIdentity` over the
 * contract's `typeof`), and the runtime object carries the authoritative
 * `validate`/`onInvalid` at the trust boundary.
 *
 * Exactly one contract is allowed — more than one is a diagnostic (the runtime
 * boundary and the emitted `ctx.auth` type each expect a single contract).
 */
const discoverIdentity = (project: Project, lunoraDirectory: string): IdentityIR | undefined => {
    const identityPath = join(lunoraDirectory, IDENTITY_FILENAME);

    if (!existsSync(identityPath)) {
        return undefined;
    }

    const source = project.getSourceFile(identityPath) ?? project.addSourceFileAtPath(identityPath);
    const identities = identitiesFromSource(source);

    if (identities.length === 0) {
        return undefined;
    }

    if (identities.length > 1) {
        throw diagnosticAt(
            source,
            `lunora/identity.ts declares ${identities.length.toString()} defineIdentity() contracts (${identities
                .map((identity) => identity.exportName)
                .join(", ")}); exactly one is allowed`,
        );
    }

    return identities[0];
};

export { discoverIdentity, IDENTITY_FILENAME };
