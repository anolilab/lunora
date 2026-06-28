import { existsSync } from "node:fs";
import { join } from "node:path";

import type { CallExpression, Identifier, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "./diagnostics";
import type { MutatorIR } from "./ir";

/** The only file custom mutators may be declared in — mirrors `lunora/queues.ts`. */
const MUTATORS_FILENAME = "mutators.ts";

/** Both module specifiers `defineMutator` may be imported from (granular + umbrella). */
const MUTATOR_MODULE_SPECIFIERS = new Set(["@lunora/server", "lunorash/server"]);

/**
 * Decide whether a callee identifier refers to `defineMutator` from
 * `@lunora/server` (or its `lunorash/server` umbrella subpath). Mirrors
 * `isDefineQueue`: trust the import declaration when the checker has a symbol
 * (so aliasing survives), and fall back to the surface text when no symbol is
 * available.
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

        if (!MUTATOR_MODULE_SPECIFIERS.has(declaration.getImportDeclaration().getModuleSpecifierValue())) {
            return false;
        }

        return declaration.getNameNode().getText() === "defineMutator";
    }

    return false;
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

        const callee = (initializer as CallExpression).getExpression();

        if (!Node.isIdentifier(callee) || !isDefineMutator(callee)) {
            continue;
        }

        const nameNode = declaration.getNameNode();

        if (!Node.isIdentifier(nameNode)) {
            throw diagnosticAt(nameNode, "defineMutator exports must be plain named exports (no destructuring)");
        }

        mutators.push({ exportName: nameNode.getText(), filePath: "mutators" });
    }

    return mutators;
};

/**
 * Discover every custom mutator the project declares: exported
 * `defineMutator()` calls in `lunora/mutators.ts`. Returns `[]` when the file
 * doesn't exist. Only the export binding is lifted — the runtime object carries
 * the authoritative `server` impl + `handler`, so codegen never evaluates the
 * body. The client `client` impl is split into the browser bundle separately.
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

export { discoverMutators, MUTATORS_FILENAME };
