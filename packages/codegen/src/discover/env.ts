import { existsSync } from "node:fs";
import { join } from "node:path";

import type { CallExpression, Identifier, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "./diagnostics";
import type { EnvIR } from "./ir";
import { isServerPackageModule } from "./module-specifiers";

/** The only file a `defineEnv` contract may be declared in — mirrors `lunora/identity.ts`. */
const ENV_FILENAME = "env.ts";

/**
 * Decide whether a callee identifier refers to `defineEnv` from `@lunora/server`
 * (or its `lunorash/server` umbrella subpath). Mirrors `isDefineIdentity`: trust
 * the import declaration when the checker has a symbol (so aliasing survives),
 * and fall back to the surface text when no symbol is available.
 */
const isDefineEnv = (identifier: Identifier): boolean => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return identifier.getText() === "defineEnv";
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        if (!isServerPackageModule(declaration.getImportDeclaration().getModuleSpecifierValue())) {
            return false;
        }

        return declaration.getNameNode().getText() === "defineEnv";
    }

    return false;
};

/**
 * Decide whether `identifier` is a namespace binding of an allowed env module —
 * the `server` in `import * as server from "@lunora/server"`. Used to recognize
 * the member-access callee form `server.defineEnv(...)`.
 */
const isEnvNamespaceImport = (identifier: Identifier): boolean => {
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
 * Decide whether a call's callee is `defineEnv` — either the bare imported
 * identifier (`defineEnv(...)`) or a namespace member access
 * (`server.defineEnv(...)`). Both are valid ES module syntax, so discovery must
 * see the contract declared either way.
 */
const isDefineEnvCallee = (callee: TsNode): boolean => {
    if (Node.isIdentifier(callee)) {
        return isDefineEnv(callee);
    }

    if (Node.isPropertyAccessExpression(callee)) {
        const object = callee.getExpression();

        return callee.getName() === "defineEnv" && Node.isIdentifier(object) && isEnvNamespaceImport(object);
    }

    return false;
};

/** Collect exported `defineEnv` declarations from one source file. */
const environmentsFromSource = (source: SourceFile): EnvIR[] => {
    const environments: EnvIR[] = [];

    for (const declaration of source.getVariableDeclarations()) {
        if (!declaration.isExported()) {
            continue;
        }

        const initializer = declaration.getInitializer();

        if (initializer?.getKind() !== SyntaxKind.CallExpression) {
            continue;
        }

        const callExpression = initializer as CallExpression;

        if (!isDefineEnvCallee(callExpression.getExpression())) {
            continue;
        }

        const nameNode = declaration.getNameNode();

        if (!Node.isIdentifier(nameNode)) {
            throw diagnosticAt(nameNode, "defineEnv exports must be plain named exports (no destructuring)");
        }

        environments.push({ exportName: nameNode.getText() });
    }

    return environments;
};

/**
 * Discover the single env contract the project declares: the exported
 * `defineEnv()` call in `lunora/env.ts`. Returns `undefined` when the file
 * doesn't exist — so a project without one emits byte-identical generated code.
 * Only the export binding is lifted; the emitted server type recovers the
 * validated shape from the declaration itself (`ReturnType` over the accessor's
 * `typeof`), and the generated ShardDO applies the same accessor to the worker
 * `env` to populate `ctx.env`.
 *
 * Exactly one contract is allowed — more than one is a diagnostic (the emitted
 * `ctx.env` type and the ctx-build wiring each expect a single accessor).
 */
const discoverEnv = (project: Project, lunoraDirectory: string): EnvIR | undefined => {
    const envPath = join(lunoraDirectory, ENV_FILENAME);

    if (!existsSync(envPath)) {
        return undefined;
    }

    const source = project.getSourceFile(envPath) ?? project.addSourceFileAtPath(envPath);
    const environments = environmentsFromSource(source);

    if (environments.length === 0) {
        return undefined;
    }

    if (environments.length > 1) {
        throw diagnosticAt(
            source,
            `lunora/env.ts declares ${environments.length.toString()} defineEnv() contracts (${environments.map((env) => env.exportName).join(", ")}); exactly one is allowed`,
        );
    }

    return environments[0];
};

export { discoverEnv, ENV_FILENAME };
