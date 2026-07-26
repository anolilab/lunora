import { existsSync } from "node:fs";
import { join } from "node:path";

import type { CallExpression, Identifier, Node as TsNode, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "./diagnostics";
import { unwrapHandlerReturn } from "./discover-functions";
import type { MutatorIR, ValidatorIR } from "./ir";
import { isServerSurfaceModule } from "./module-specifiers";
import { parseObjectShape } from "./parse-validator";

/** The only file custom mutators may be declared in — mirrors `lunora/queues.ts`. */
const MUTATORS_FILENAME = "mutators.ts";

/**
 * True for any module specifier `defineMutator` may come from. Includes the
 * generated `_generated/server` re-export, which binds `ctx` to this project's
 * typed `MutationCtx` and is therefore the form mutators SHOULD be authored with.
 */
const isMutatorSurfaceModule = isServerSurfaceModule;

/**
 * Decide whether a callee identifier refers to `defineMutator` from
 * `@lunora/server` (its `lunorash/server` umbrella subpath, or the generated
 * `_generated/server` re-export). Mirrors `isDefineQueue`: trust the import
 * declaration when the checker has a symbol (so aliasing survives), and fall back
 * to the surface text when no symbol is available.
 */
const isDefineMutator = (identifier: Identifier): boolean => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return identifier.getText() === "defineMutator";
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        if (!isMutatorSurfaceModule(declaration.getImportDeclaration().getModuleSpecifierValue())) {
            return false;
        }

        return declaration.getNameNode().getText() === "defineMutator";
    }

    return false;
};

/**
 * Decide whether `identifier` is a namespace binding of an allowed mutator
 * module — the `server` in `import * as server from "@lunora/server"`. Used to
 * recognize the member-access callee form `server.defineMutator(...)`.
 */
const isMutatorNamespaceImport = (identifier: Identifier): boolean => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return false;
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isNamespaceImport(declaration)) {
            continue;
        }

        const importDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);

        return importDeclaration !== undefined && isMutatorSurfaceModule(importDeclaration.getModuleSpecifierValue());
    }

    return false;
};

/**
 * Decide whether a call's callee is `defineMutator` — either the bare imported
 * identifier (`defineMutator(...)`) or a namespace member access
 * (`server.defineMutator(...)`). Both are valid ES module syntax, so discovery
 * must see mutators declared either way.
 */
const isDefineMutatorCallee = (callee: TsNode): boolean => {
    if (Node.isIdentifier(callee)) {
        return isDefineMutator(callee);
    }

    if (Node.isPropertyAccessExpression(callee)) {
        const object = callee.getExpression();

        return callee.getName() === "defineMutator" && Node.isIdentifier(object) && isMutatorNamespaceImport(object);
    }

    return false;
};

/**
 * The `{ args, client, server }` object literal a `defineMutator` call was given,
 * or `undefined` when the argument isn't an inline literal (a hoisted definition
 * object — the args/return types then stay unresolved rather than guessed).
 */
const mutatorLiteral = (call: CallExpression): ObjectLiteralExpression | undefined => {
    const first = call.getArguments()[0];

    return first && Node.isObjectLiteralExpression(first) ? first : undefined;
};

/**
 * The mutator's `args` validator map, parsed with the same `parseObjectShape` a
 * procedure's `args` goes through so `api.mutators.&lt;name>` and `api.&lt;file>.&lt;fn>`
 * can never render a validator differently. `{}` when `args` is absent (a
 * parameterless mutator) or isn't an inline object literal.
 */
const argsFromMutator = (literal: ObjectLiteralExpression | undefined): Record<string, ValidatorIR> => {
    const argsProperty = literal?.getProperty("args");

    if (!argsProperty || !Node.isPropertyAssignment(argsProperty)) {
        return {};
    }

    const initializer = argsProperty.getInitializer();

    return initializer && Node.isObjectLiteralExpression(initializer) ? parseObjectShape(initializer) : {};
};

/**
 * The authoritative `server` impl's return type, `Promise&lt;…>` unwrapped — the
 * `Return` of the emitted `api.mutators.&lt;name>` reference, so `ctx.runMutation`
 * on it (and a `useMutation` over it) resolves the real result instead of
 * `unknown`. `"unknown"` when `server` isn't an inline function.
 */
const returnTypeFromMutator = (literal: ObjectLiteralExpression | undefined): string => {
    const serverProperty = literal?.getProperty("server");

    if (!serverProperty || !Node.isPropertyAssignment(serverProperty)) {
        return "unknown";
    }

    const initializer = serverProperty.getInitializer();

    if (!initializer || !(Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
        return "unknown";
    }

    return unwrapHandlerReturn(initializer);
};

/** Collect exported `defineMutator` declarations from one source file. */
const mutatorsFromSource = (source: SourceFile): MutatorIR[] => {
    const mutators: MutatorIR[] = [];

    for (const declaration of source.getVariableDeclarations()) {
        if (!declaration.isExported()) {
            continue;
        }

        const initializer = declaration.getInitializer();

        if (initializer?.getKind() !== SyntaxKind.CallExpression) {
            continue;
        }

        const call = initializer as CallExpression;
        const callee = call.getExpression();

        if (!isDefineMutatorCallee(callee)) {
            continue;
        }

        const nameNode = declaration.getNameNode();

        if (!Node.isIdentifier(nameNode)) {
            throw diagnosticAt(nameNode, "defineMutator exports must be plain named exports (no destructuring)");
        }

        const literal = mutatorLiteral(call);

        mutators.push({
            args: argsFromMutator(literal),
            exportName: nameNode.getText(),
            filePath: "mutators",
            returnType: returnTypeFromMutator(literal),
        });
    }

    return mutators;
};

/**
 * Discover every custom mutator the project declares: exported
 * `defineMutator()` calls in `lunora/mutators.ts`. Returns `[]` when the file
 * doesn't exist. The export binding plus the declared `args` / `server` return
 * type are lifted — enough to emit a typed `api.mutators.&lt;name>` reference —
 * while the runtime object still carries the authoritative `server` impl +
 * `handler`, so codegen never evaluates the body. The client `client` impl is
 * split into the browser bundle separately.
 */
const discoverMutators = (project: Project, lunoraDirectory: string): MutatorIR[] => {
    const mutatorsPath = join(lunoraDirectory, MUTATORS_FILENAME);

    if (!existsSync(mutatorsPath)) {
        return [];
    }

    const source = project.getSourceFile(mutatorsPath) ?? project.addSourceFileAtPath(mutatorsPath);
    const mutators = mutatorsFromSource(source);

    mutators.sort((a, b) => a.exportName.localeCompare(b.exportName));

    return mutators;
};

export { discoverMutators, isDefineMutatorCallee, MUTATORS_FILENAME };
