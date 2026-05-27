import { readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import { Node, Project, SyntaxKind } from "ts-morph";
import type { CallExpression, SourceFile } from "ts-morph";

import type { FunctionIR, ValidatorIR } from "./ir.js";
import { parseObjectShape } from "./parseValidator.js";

const FUNCTION_KINDS = new Set(["action", "mutation", "query"]);

const walk = (directory: string, accumulator: string[] = []): string[] => {
    let entries: string[] = [];

    try {
        entries = readdirSync(directory);
    } catch {
        return accumulator;
    }

    for (const entry of entries) {
        const full = join(directory, entry);
        const info = statSync(full);

        if (info.isDirectory()) {
            if (entry === "_generated" || entry === "node_modules") {
                continue;
            }

            walk(full, accumulator);
        } else if (info.isFile() && extname(entry) === ".ts" && entry !== "schema.ts") {
            accumulator.push(full);
        }
    }

    return accumulator;
};

/** Inspect a `query({ args, handler })` call and pull out the args validator map. */
const argsFromCall = (call: CallExpression): Record<string, ValidatorIR> => {
    const first = call.getArguments()[0];

    if (!first || !Node.isObjectLiteralExpression(first)) {
        return {};
    }

    const argsProperty = first.getProperty("args");

    if (!argsProperty || !Node.isPropertyAssignment(argsProperty)) {
        return {};
    }

    const initializer = argsProperty.getInitializer();

    if (!initializer || !Node.isObjectLiteralExpression(initializer)) {
        return {};
    }

    return parseObjectShape(initializer);
};

/**
 * Scan all .ts files under `cirrusDir` (skipping `_generated/` and `schema.ts`)
 * for top-level `export const x = query/mutation/action({...})` registrations.
 */
export const discoverFunctions = (project: Project, cirrusDirectory: string): FunctionIR[] => {
    const filePaths = walk(cirrusDirectory);
    const functions: FunctionIR[] = [];

    for (const filePath of filePaths) {
        const source: SourceFile = project.addSourceFileAtPath(filePath);
        const relativePath = relative(cirrusDirectory, filePath).split(sep).join("/").replace(/\.ts$/u, "");

        for (const statement of source.getVariableStatements()) {
            if (!statement.isExported()) {
                continue;
            }

            for (const declaration of statement.getDeclarations()) {
                const initializer = declaration.getInitializer();

                if (!initializer || initializer.getKind() !== SyntaxKind.CallExpression) {
                    continue;
                }

                const call = initializer as CallExpression;
                const callee = call.getExpression();
                // TODO(v0.2): resolve through symbol/type info so aliased imports
                // (`import { query as q } from "@cirrus/server"`) are detected.
                // The current text-based detection works for the common case
                // where consumers import the helpers by their canonical names.
                const kind = Node.isIdentifier(callee) ? callee.getText() : null;

                if (!kind || !FUNCTION_KINDS.has(kind)) {
                    continue;
                }

                functions.push({
                    args: argsFromCall(call),
                    exportName: declaration.getName(),
                    filePath: relativePath,
                    kind: kind as FunctionIR["kind"],
                });
            }
        }
    }

    functions.sort((a, b) => `${a.filePath}:${a.exportName}`.localeCompare(`${b.filePath}:${b.exportName}`));

    return functions;
};
