import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ArrowFunction, FunctionExpression, Node as TsNode, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { ConfigCallIR } from "../ir";
import { listSecurityScanFiles, objectLiteralFromCallbackBody } from "./ast";
import { calleeName } from "./callee";

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

/**
 * The `@lunora/vite` plugin factory. `lunora({ allowUnauthenticatedShardAccess:
 * true })` in `vite.config.*` is the DOCUMENTED opt-in for the auto-composed
 * class-A worker (`framework-compose-plugin` bakes the flag into the virtual
 * worker entry), and a class-A app has no worker entry to call `.extend()`
 * from — so on the default Vite path this is the ONLY place the setting exists.
 */
const VITE_PLUGIN_CALLEE = "lunora";

/**
 * Vite config filenames probed at the project root, in Vite's own resolution
 * order. Only the first that exists is read — Vite loads exactly one.
 */
const VITE_CONFIG_FILES = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"] as const;

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
 * Read the `lunora(...)` plugin options out of the project's Vite config.
 *
 * Parsed as source, never executed: this runs inside codegen, and evaluating a
 * user config would import the whole plugin graph. A config that computes its
 * options (`lunora(preset)`) reads as not analyzable, exactly like every other
 * opaque config argument here.
 *
 * `file` keeps its extension, unlike the `lunora/`-relative paths: `vite.config`
 * is not a file anyone can open.
 */
const viteConfigCalls = (project: Project, projectRoot: string): ConfigCallIR[] => {
    for (const name of VITE_CONFIG_FILES) {
        const filePath = join(projectRoot, name);

        if (!existsSync(filePath)) {
            continue;
        }

        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const rows: ConfigCallIR[] = [];

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            if (calleeName(call.getExpression()) !== VITE_PLUGIN_CALLEE) {
                continue;
            }

            rows.push({ callee: VITE_PLUGIN_CALLEE, file: name, line: call.getStartLineNumber(), ...readConfigArgument(call.getArguments()[0]) });
        }

        return rows;
    }

    return [];
};

/**
 * Discover factory/constructor/callback-builder calls whose config
 * object literal a security lint inspects for a present-or-absent key — the
 * shared input for the config-call security lints (payment authorize,
 * inbound-mail verify, rate-limit store, browser private-targets, unauthenticated
 * shard access). Scans the worker entry as well as `lunora/` (see
 * {@link listSecurityScanFiles}) — every one of these factories is constructed in
 * the entry by convention, so a `lunora/`-only walk found nothing to lint — plus
 * the project's Vite config (see {@link viteConfigCalls}), which on the default
 * class-A path is the only place the unauthenticated-shard-access opt-in can be
 * set at all. Records the callee name and, when the config was a statically
 * readable object literal (a bare argument, or a callback's returned object
 * literal), the keys present and the subset assigned the literal `true`; the
 * lints decide what an absent (or present-and-true) key means.
 */
const discoverConfigCalls = (project: Project, lunoraDirectory: string): ConfigCallIR[] => {
    const calls: ConfigCallIR[] = [];

    for (const { displayPath, filePath } of listSecurityScanFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        calls.push(...configCallsInSourceFile(sourceFile, displayPath));
    }

    calls.push(...viteConfigCalls(project, dirname(lunoraDirectory)));

    return calls;
};

export default discoverConfigCalls;
