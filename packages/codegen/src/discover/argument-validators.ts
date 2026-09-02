import type { ObjectLiteralExpression, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node } from "ts-morph";

import type { ArgumentValidatorIR } from "../ir";
import { procedureArgumentObjects } from "../procedure-argument-objects";
import { listLunoraSourceFiles, lunoraRelativePath } from "./ast";
import { classifyProcedureCall } from "./functions/classify-procedure-call";

/**
 * Chain methods that actually bound a string's length.
 *
 * `.meta()` is deliberately absent. It is documented in `@lunora/values` as
 * carrying "pure metadata (description + JSON Schema constraint fragment) with
 * no effect on runtime parsing" — it reuses the parser unchanged — so a
 * `.meta({ schema: { maxLength: 200 } })` is a claim about the emitted schema and
 * nothing the runtime enforces. The text-matching predicate this replaced
 * accepted it, and accepted the bare substrings `length` and `max` anywhere in
 * the initializer besides: a comment, a nested field NAME (`v.object({ maxItems
 * })`), a default string. Every one of those cleared the lint for an argument
 * that is genuinely unbounded.
 *
 * `.check()` stays: it is the escape hatch a length predicate is written through
 * (`v.string().check((s) => s.length <= 200, …)`), and its predicate is a
 * function body this pass cannot read. Accepting it over-clears rather than
 * over-reports, which is the right direction for an advisory lint.
 *
 * Same shape as `admin-routes.ts`'s guard detection, and for the same reason
 * written down there: the path literal and the comments must not be able to
 * false-clear the check.
 */
const BOUNDING_METHODS = new Set(["check", "length", "max"]);

/** The `v.<name>(…)` factory a call expression invokes, or `undefined` when it is not one. */
const vFactoryName = (node: Node): string | undefined => {
    if (!Node.isCallExpression(node)) {
        return undefined;
    }

    const expression = node.getExpression();

    if (!Node.isPropertyAccessExpression(expression) || expression.getExpression().getText() !== "v") {
        return undefined;
    }

    return expression.getName();
};

/** Every `v.<name>(…)` call inside `initializer`, including the initializer itself. */
const vFactoryCalls = (initializer: Node): Node[] => [initializer, ...initializer.getDescendants()].filter((node) => vFactoryName(node) !== undefined);

/**
 * Whether a bounding method is applied to `call` — walking the chain
 * (`v.string().min(1).max(200)`) rather than the source text, so only a real
 * method call on this very validator counts.
 */
const isBounded = (call: Node): boolean => {
    let current = call;

    for (;;) {
        const access = current.getParent();

        if (!access || !Node.isPropertyAccessExpression(access) || access.getExpression() !== current) {
            return false;
        }

        const invocation = access.getParent();

        if (!invocation || !Node.isCallExpression(invocation) || invocation.getExpression() !== access) {
            return false;
        }

        if (BOUNDING_METHODS.has(access.getName())) {
            return true;
        }

        current = invocation;
    }
};

/** Classify every arg property across the given object literals into any-typed and unbounded-string buckets. */
const classifyArgs = (objects: ReadonlyArray<ObjectLiteralExpression>): { anyArgs: string[]; unboundedStringArgs: string[] } => {
    const anyArgs: string[] = [];
    const unboundedStringArgs: string[] = [];

    for (const object of objects) {
        for (const property of object.getProperties()) {
            if (!Node.isPropertyAssignment(property)) {
                continue;
            }

            const initializer = property.getInitializer();

            if (!initializer) {
                continue;
            }

            const calls = vFactoryCalls(initializer);
            const name = property.getName();

            if (calls.some((call) => vFactoryName(call) === "any")) {
                anyArgs.push(name);
            } else if (calls.some((call) => vFactoryName(call) === "string" && !isBounded(call))) {
                unboundedStringArgs.push(name);
            }
        }
    }

    return { anyArgs, unboundedStringArgs };
};

/** Build the {@link ArgumentValidatorIR} for one exported public procedure, or `undefined` when it isn't one (or has no flagged args). */
const argumentValidatorIrFromDeclaration = (declaration: VariableDeclaration, relativePath: string): ArgumentValidatorIR | undefined => {
    const initializer = declaration.getInitializer();

    if (!initializer || !Node.isCallExpression(initializer)) {
        return undefined;
    }

    const classified = classifyProcedureCall(initializer);

    // Only public procedures take untrusted input; internal functions are
    // server-called with already-validated arguments.
    if (classified?.visibility !== "public") {
        return undefined;
    }

    const { objects } = procedureArgumentObjects(initializer, classified.receiver);

    const { anyArgs, unboundedStringArgs } = classifyArgs(objects);

    if (anyArgs.length === 0 && unboundedStringArgs.length === 0) {
        return undefined;
    }

    return {
        anyArgs,
        exportName: declaration.getName(),
        file: relativePath,
        line: initializer.getStartLineNumber(),
        unboundedStringArgs,
    };
};

/** Per-procedure arg-validator snapshots across one source file. */
const argumentValidatorsInSourceFile = (sourceFile: SourceFile, relativePath: string): ArgumentValidatorIR[] => {
    const found: ArgumentValidatorIR[] = [];

    for (const statement of sourceFile.getVariableStatements()) {
        if (!statement.isExported()) {
            continue;
        }

        for (const declaration of statement.getDeclarations()) {
            const ir = argumentValidatorIrFromDeclaration(declaration, relativePath);

            if (ir) {
                found.push(ir);
            }
        }
    }

    return found;
};

/**
 * Discover, per exported **public** query/mutation/action under the lunora source
 * directory, the argument validators that weaken input safety: `v.any()` args
 * (unvalidated, untyped input — the `public_arg_uses_any` lint) and `v.string()`
 * args with no `.max()`/`.length()`/`.check()` length bound (a DoS /
 * storage-abuse vector — the `unbounded_string_arg` lint). Only procedures with at least one flagged arg
 * are recorded. Internal functions are skipped: they take server-trusted input.
 */
const discoverArgumentValidators = (project: Project, lunoraDirectory: string): ArgumentValidatorIR[] => {
    const procedures: ArgumentValidatorIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        procedures.push(...argumentValidatorsInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return procedures;
};

export default discoverArgumentValidators;
