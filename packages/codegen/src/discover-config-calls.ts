import type { ArrowFunction, Block, FunctionExpression, Node as TsNode, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { calleeName } from "./argument-taint";
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
 * Chained builder methods whose first-argument *callback* (not a bare object
 * literal) returns the config object literal a security lint inspects — the
 * generated `defineApp()...extend(fn)` escape hatch (`fn: (env, derived) =>
 * Partial<WorkerOptions>`, merged straight into the `createWorker(...)` options
 * — see `emit-app.ts`'s `buildWorkerOptions`). Matched by name only (the same
 * import-agnostic convention as {@link FUNCTION_CALLEES}); the compound
 * signature of the method name plus a specific `trueKeys` member is precise
 * enough to hold the false-positive rate down without also verifying the
 * receiver is a `defineApp()` chain.
 */
const CALLBACK_CALLEES = new Set(["extend"]);

/** The subset of {@link ConfigCallIR} a config/callback reader can determine from the argument alone — the caller fills in `callee`/`file`/`line`. */
type ConfigCallEvidence = Pick<ConfigCallIR, "analyzable" | "presentKeys" | "trueKeys">;

/**
 * Read an object literal's properties into the present/true key sets. A spread
 * (`{ ...base }`) makes the literal opaque — keys could be contributed
 * elsewhere, so the absent-key lints must skip it rather than flag on a key the
 * merged object may well set.
 */
const keysFromObjectLiteral = (objectLiteral: ObjectLiteralExpression): ConfigCallEvidence => {
    const presentKeys: string[] = [];
    const trueKeys: string[] = [];
    let hasSpread = false;

    for (const property of objectLiteral.getProperties()) {
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

/**
 * Read a config object-literal argument into the present/true key sets. A
 * non-object argument (a variable, call result, or missing) is *not* analyzable.
 */
const readConfigArgument = (argument: TsNode | undefined): ConfigCallEvidence =>
    argument && Node.isObjectLiteralExpression(argument) ? keysFromObjectLiteral(argument) : { analyzable: false, presentKeys: [], trueKeys: [] };

/** The sole statement of a single-statement `{ return {...}; }` block, when it returns an object literal. */
const objectLiteralFromReturnBlock = (block: Block): ObjectLiteralExpression | undefined => {
    const statements = block.getStatements();
    const [statement] = statements;

    if (statements.length !== 1 || statement === undefined || !Node.isReturnStatement(statement)) {
        return undefined;
    }

    const expression = statement.getExpression();

    return expression !== undefined && Node.isObjectLiteralExpression(expression) ? expression : undefined;
};

/**
 * The object literal a callback body evaluates to, covering the concise-body
 * form (`() => ({...})`, where the parens make the object literal the whole
 * body) and the block-body form (`() => { return {...}; }`). Anything else
 * (a variable, a multi-statement block, a conditional) is not analyzable.
 */
const objectLiteralFromCallbackBody = (body: TsNode): ObjectLiteralExpression | undefined => {
    if (Node.isObjectLiteralExpression(body)) {
        return body;
    }

    if (Node.isParenthesizedExpression(body)) {
        const inner = body.getExpression();

        return Node.isObjectLiteralExpression(inner) ? inner : undefined;
    }

    return Node.isBlock(body) ? objectLiteralFromReturnBlock(body) : undefined;
};

/**
 * Read a callback argument (an arrow function or function expression) whose
 * body returns the config object literal — the `.extend(fn)` shape. A
 * non-callback argument, or a callback whose body isn't statically an object
 * literal, is *not* analyzable.
 */
const readCallbackArgument = (argument: TsNode | undefined): ConfigCallEvidence => {
    const callback: ArrowFunction | FunctionExpression | undefined =
        argument && (Node.isArrowFunction(argument) || Node.isFunctionExpression(argument)) ? argument : undefined;
    const objectLiteral = callback && objectLiteralFromCallbackBody(callback.getBody());

    return objectLiteral ? keysFromObjectLiteral(objectLiteral) : { analyzable: false, presentKeys: [], trueKeys: [] };
};

/** Config-shaped factory/constructor/callback-builder calls in one source file. */
const configCallsInSourceFile = (sourceFile: SourceFile, relativePath: string): ConfigCallIR[] => {
    const found: ConfigCallIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const name = calleeName(call.getExpression());

        if (name === undefined) {
            continue;
        }

        if (FUNCTION_CALLEES.has(name)) {
            found.push({ callee: name, file: relativePath, line: call.getStartLineNumber(), ...readConfigArgument(call.getArguments()[0]) });
        } else if (CALLBACK_CALLEES.has(name)) {
            found.push({ callee: name, file: relativePath, line: call.getStartLineNumber(), ...readCallbackArgument(call.getArguments()[0]) });
        }
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
 * Discover factory/constructor/callback-builder calls in `lunora/` whose config
 * object literal a security lint inspects for a present-or-absent key — the
 * shared input for the config-call security lints (payment authorize,
 * inbound-mail verify, rate-limit store, browser private-targets, unauthenticated
 * shard access). Records the callee name and, when the config was a statically
 * readable object literal (a bare argument, or a callback's returned object
 * literal), the keys present and the subset assigned the literal `true`; the
 * lints decide what an absent (or present-and-true) key means.
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
