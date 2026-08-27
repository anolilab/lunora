import { existsSync } from "node:fs";
import { join } from "node:path";

import type { CallExpression, Identifier, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "./diagnostics";
import type { ShapeIR, ValidatorIR } from "./ir";
import { isServerPackageModule } from "./module-specifiers";
import { parseObjectShape } from "./parse-validator";

/** The only file shapes may be declared in — mirrors `lunora/queues.ts`. */
const SHAPES_FILENAME = "shapes.ts";

/**
 * Decide whether a callee identifier refers to `defineShape` from
 * `@lunora/server` (or its `lunorash/server` umbrella subpath). Mirrors
 * `isDefineQueue`: trust the import declaration when the checker has a symbol
 * (so aliasing survives), and fall back to the surface text when no symbol is
 * available.
 */
const isDefineShape = (identifier: Identifier): boolean => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return identifier.getText() === "defineShape";
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        if (!isServerPackageModule(declaration.getImportDeclaration().getModuleSpecifierValue())) {
            return false;
        }

        return declaration.getNameNode().getText() === "defineShape";
    }

    return false;
};

/**
 * Decide whether `identifier` is a namespace binding of an allowed shape module —
 * the `server` in `import * as server from "@lunora/server"`. Used to recognize
 * the member-access callee form `server.defineShape(...)`.
 */
const isShapeNamespaceImport = (identifier: Identifier): boolean => {
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
 * Decide whether a call's callee is `defineShape` — either the bare imported
 * identifier (`defineShape(...)`) or a namespace member access
 * (`server.defineShape(...)`). Both are valid ES module syntax, so discovery
 * must see shapes declared either way.
 */
const isDefineShapeCallee = (callee: TsNode): boolean => {
    if (Node.isIdentifier(callee)) {
        return isDefineShape(callee);
    }

    if (Node.isPropertyAccessExpression(callee)) {
        const object = callee.getExpression();

        return callee.getName() === "defineShape" && Node.isIdentifier(object) && isShapeNamespaceImport(object);
    }

    return false;
};

/**
 * Read the `table` string literal from a `defineShape({ table: "…" })` config
 * object. Returns `undefined` when the argument isn't an object literal or
 * `table` isn't a plain string literal — advisor lints simply skip those.
 */
const tableLiteralFrom = (call: CallExpression): string | undefined => {
    const [config] = call.getArguments();

    if (!config || !Node.isObjectLiteralExpression(config)) {
        return undefined;
    }

    const tableProperty = config.getProperty("table");

    if (!tableProperty || !Node.isPropertyAssignment(tableProperty)) {
        return undefined;
    }

    const value = tableProperty.getInitializer();

    return value && Node.isStringLiteral(value) ? value.getLiteralValue() : undefined;
};

/**
 * Read the `args` validator map from a `defineShape({ args: { … } })` config, so
 * `_generated/collections.ts` can type a shape's partition selector instead of
 * widening it to `Record<string, unknown>`. Returns `{}` for a parameterless shape
 * (or one whose `args` isn't a plain object literal — the runtime object stays
 * authoritative either way).
 */
const argsFrom = (call: CallExpression): Record<string, ValidatorIR> => {
    const [config] = call.getArguments();

    if (!config || !Node.isObjectLiteralExpression(config)) {
        return {};
    }

    const argsProperty = config.getProperty("args");

    if (!argsProperty || !Node.isPropertyAssignment(argsProperty)) {
        return {};
    }

    const initializer = argsProperty.getInitializer();

    if (!initializer || !Node.isObjectLiteralExpression(initializer)) {
        return {};
    }

    return parseObjectShape(initializer);
};

/** Collect exported `defineShape` declarations from one source file. */
const shapesFromSource = (source: SourceFile): ShapeIR[] => {
    const shapes: ShapeIR[] = [];

    for (const declaration of source.getVariableDeclarations()) {
        if (!declaration.isExported()) {
            continue;
        }

        const initializer = declaration.getInitializer();

        if (initializer?.getKind() !== SyntaxKind.CallExpression) {
            continue;
        }

        const callExpression = initializer as CallExpression;
        const callee = callExpression.getExpression();

        if (!isDefineShapeCallee(callee)) {
            continue;
        }

        const nameNode = declaration.getNameNode();

        if (!Node.isIdentifier(nameNode)) {
            throw diagnosticAt(nameNode, "defineShape exports must be plain named exports (no destructuring)");
        }

        shapes.push({ args: argsFrom(callExpression), exportName: nameNode.getText(), filePath: "shapes", table: tableLiteralFrom(callExpression) });
    }

    return shapes;
};

/**
 * Discover every replication shape the project declares: exported
 * `defineShape()` calls in `lunora/shapes.ts`. Returns `[]` when the file
 * doesn't exist. Only the export binding is lifted — the runtime object carries
 * the authoritative `table`/`columns`/`compileWhere`, so codegen never
 * evaluates the predicate.
 */
const discoverShapes = (project: Project, lunoraDirectory: string): ShapeIR[] => {
    const shapesPath = join(lunoraDirectory, SHAPES_FILENAME);

    if (!existsSync(shapesPath)) {
        return [];
    }

    const source = project.getSourceFile(shapesPath) ?? project.addSourceFileAtPath(shapesPath);
    const shapes = shapesFromSource(source);

    shapes.sort((a, b) => a.exportName.localeCompare(b.exportName));

    return shapes;
};

export { discoverShapes, SHAPES_FILENAME };
