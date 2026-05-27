import { readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import type { CallExpression, Identifier, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { FunctionIR, ValidatorIR } from "./ir.js";
import { parseObjectShape } from "./parseValidator.js";
import { sanitizeNamespace } from "./paths.js";

const FUNCTION_KINDS = new Set(["action", "mutation", "query"]);

/**
 * Resolve a callee identifier through its import declaration, returning the
 * **imported** name (i.e. the name as exported from `@cirrus/server`). This
 * handles aliasing like `import { query as q }` where the call site uses `q`
 * but the registration kind is `query`. Returns `null` when the identifier
 * is not imported from `@cirrus/server`, so we don't accidentally pick up
 * a local `const query = ...`.
 */
const resolveCalleeKind = (identifier: Identifier): string | null => {
    const symbol = identifier.getSymbol();

    // No type-checker info at all (no tsconfig wired up). Fall back to the
    // surface text — preserves the prior behaviour for users that haven't
    // configured ts-morph with a real project.
    if (!symbol) {
        return identifier.getText();
    }

    const declarations = symbol.getDeclarations();

    for (const declaration of declarations) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        const importDeclaration = declaration.getImportDeclaration();
        const moduleSpecifier = importDeclaration.getModuleSpecifierValue();

        // Only trust identifiers imported from the public Cirrus surface.
        if (moduleSpecifier !== "@cirrus/server") {
            return null;
        }

        // `import { query as q }` → declaration.getNameNode() is `query`,
        // declaration.getAliasNode() is `q`. The kind we care about is the
        // exported name, not the local alias.
        return declaration.getNameNode().getText();
    }

    // Symbol exists but no `@cirrus/server` import specifier among its
    // declarations — it's a local binding (`const query = ...`) or imported
    // from somewhere else. Reject so we don't pick it up as a registration.
    return null;
};

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
 * Pull the handler's return type out of a `query/mutation/action` call using
 * ts-morph's type checker. Unwraps the outer `Promise<…>` so the emitted
 * `FunctionReference<Kind, Args, Return>` matches what callers see post-await.
 *
 * Returns `"unknown"` when the type checker can't resolve enough context —
 * typical when running against a stand-alone fixture without a tsconfig.
 */
const returnTypeFromCall = (call: CallExpression): string => {
    const first = call.getArguments()[0];

    if (!first || !Node.isObjectLiteralExpression(first)) {
        return "unknown";
    }

    const handlerProperty = first.getProperty("handler");

    if (!handlerProperty || !Node.isPropertyAssignment(handlerProperty)) {
        return "unknown";
    }

    const initializer = handlerProperty.getInitializer();

    if (!initializer || !(Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
        return "unknown";
    }

    const signature = initializer.getType().getCallSignatures()[0];

    if (!signature) {
        return "unknown";
    }

    let returnType = signature.getReturnType();

    // Unwrap a single layer of `Promise<…>`. The runtime always awaits the
    // handler, so callers should see the resolved type — not the wrapper.
    const symbol = returnType.getSymbol() ?? returnType.getAliasSymbol();

    if (symbol?.getName() === "Promise") {
        const innerTypeArgument = returnType.getTypeArguments()[0];

        if (innerTypeArgument) {
            returnType = innerTypeArgument;
        }
    }

    const rendered = returnType.getText(initializer);

    // `any`/empty fall back to `unknown` so downstream typings stay strict.
    if (!rendered || rendered === "any" || rendered === "never") {
        return "unknown";
    }

    // If `any` appears as a standalone identifier anywhere in the rendered
    // type (e.g. `{ channelId: any; ... }`), the type checker is in degraded
    // mode — typically because the consuming project lacks the tsconfig
    // wiring to resolve `@cirrus/server`/`@cirrus/values`. Surfacing such
    // partial types would mislead users; fall back to `unknown` instead.
    if (/\bany\b/u.test(rendered)) {
        return "unknown";
    }

    return rendered;
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

                if (initializer?.getKind() !== SyntaxKind.CallExpression) {
                    continue;
                }

                const call = initializer as CallExpression;
                const callee = call.getExpression();

                if (!Node.isIdentifier(callee)) {
                    continue;
                }

                const kind = resolveCalleeKind(callee);

                if (!kind || !FUNCTION_KINDS.has(kind)) {
                    continue;
                }

                functions.push({
                    args: argsFromCall(call),
                    exportName: declaration.getName(),
                    filePath: relativePath,
                    kind: kind as FunctionIR["kind"],
                    returnType: returnTypeFromCall(call),
                });
            }
        }
    }

    functions.sort((a, b) => `${a.filePath}:${a.exportName}`.localeCompare(`${b.filePath}:${b.exportName}`));

    // Detect namespace collisions: two distinct file paths that sanitize to
    // the same identifier (e.g. `foo/bar.ts` and `foo-bar.ts` both → `foo_bar`).
    // Without this guard, emit silently produces duplicate `ApiTypes` keys
    // and an ambiguous dispatch table.
    const namespaceOrigins = new Map<string, string>();

    for (const function_ of functions) {
        const namespace = sanitizeNamespace(function_.filePath);
        const prior = namespaceOrigins.get(namespace);

        if (prior && prior !== function_.filePath) {
            throw Object.assign(
                new Error(
                    `Namespace collision: "${prior}" and "${function_.filePath}" both resolve to "${namespace}". `
                    + `Rename one of the files so the JS-identifier-sanitized names differ.`,
                ),
                { code: "NAMESPACE_COLLISION", name: "CirrusError", paths: [prior, function_.filePath], status: 500 },
            );
        }

        namespaceOrigins.set(namespace, function_.filePath);
    }

    return functions;
};
