import type { Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { ConfigCallIR } from "./ir";

/**
 * Factory functions whose first-argument config object literal a security lint
 * inspects. Matched by callee *name* (an `import`-agnostic, fail-closed match, the
 * same convention the other feeders use), so a re-export or alias still resolves.
 */
const FUNCTION_CALLEES = new Set(["createBrowser", "createInboundEmailHandler", "createPayment"]);

/** Constructors (`new X({...})`) whose first-argument config object literal a lint inspects. */
const CONSTRUCTOR_CALLEES = new Set(["RateLimiter"]);

/**
 * The simple callee name of a call/new expression — the trailing identifier for a
 * bare call (`createPayment`) or a member call (`payment.createPayment` →
 * `createPayment`). Returns `undefined` for anything without a resolvable name.
 */
const calleeName = (expression: TsNode): string | undefined => {
    if (Node.isIdentifier(expression)) {
        return expression.getText();
    }

    if (Node.isPropertyAccessExpression(expression)) {
        return expression.getName();
    }

    return undefined;
};

/**
 * Read a config object-literal argument into the present/true key sets. A
 * non-object argument (a variable, call result, or missing) is *not* analyzable,
 * and a spread (`{ ...base }`) makes it opaque too — keys could be contributed
 * elsewhere, so the absent-key lints must skip it rather than flag on a key the
 * merged object may well set.
 */
const readConfigArgument = (argument: TsNode | undefined): Pick<ConfigCallIR, "analyzable" | "presentKeys" | "trueKeys"> => {
    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        return { analyzable: false, presentKeys: [], trueKeys: [] };
    }

    const presentKeys: string[] = [];
    const trueKeys: string[] = [];
    let hasSpread = false;

    for (const property of argument.getProperties()) {
        if (Node.isSpreadAssignment(property)) {
            hasSpread = true;

            continue;
        }

        if (Node.isPropertyAssignment(property)) {
            const name = property.getName();

            presentKeys.push(name);

            const initializer = property.getInitializer();

            if (initializer?.getKind() === SyntaxKind.TrueKeyword) {
                trueKeys.push(name);
            }

            continue;
        }

        // A shorthand (`{ verify }`) or method (`verify() {}`) still declares the key.
        if (Node.isShorthandPropertyAssignment(property) || Node.isMethodDeclaration(property)) {
            presentKeys.push(property.getName());
        }
    }

    return { analyzable: !hasSpread, presentKeys, trueKeys };
};

/** Config-shaped factory/constructor calls in one source file. */
const configCallsInSourceFile = (sourceFile: SourceFile, relativePath: string): ConfigCallIR[] => {
    const found: ConfigCallIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const name = calleeName(call.getExpression());

        if (name === undefined || !FUNCTION_CALLEES.has(name)) {
            continue;
        }

        found.push({
            callee: name,
            file: relativePath,
            line: call.getStartLineNumber(),
            ...readConfigArgument(call.getArguments()[0]),
        });
    }

    for (const construction of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        const name = calleeName(construction.getExpression());

        if (name === undefined || !CONSTRUCTOR_CALLEES.has(name)) {
            continue;
        }

        found.push({
            callee: name,
            file: relativePath,
            line: construction.getStartLineNumber(),
            ...readConfigArgument(construction.getArguments()[0]),
        });
    }

    return found;
};

/**
 * Discover factory/constructor calls in `lunora/` whose config object literal a
 * security lint inspects for a present-or-absent key — the shared input for the
 * config-call security lints (payment authorize, inbound-mail verify, rate-limit
 * store, browser private-targets). Records the callee name and, when the config
 * was a static object literal, the keys present and the subset assigned the
 * literal `true`; the lints decide what an absent (or present-and-true) key means.
 */
const discoverConfigCalls = (project: Project, lunoraDirectory: string): ConfigCallIR[] => {
    const calls: ConfigCallIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        calls.push(...configCallsInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return calls;
};

export default discoverConfigCalls;
