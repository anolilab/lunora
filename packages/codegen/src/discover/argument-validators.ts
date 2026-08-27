import type { ObjectLiteralExpression, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node } from "ts-morph";

import { classifyProcedureCall, listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { ArgumentValidatorIR } from "./ir";
import { procedureArgumentObjects } from "./procedure-argument-objects";

/** A constraint fragment that bounds a string's length — its presence means the arg is *not* unbounded. */
const BOUND_RE = /\.check\(|\.meta\(|length|max/iu;
/** Matches a `v.any()` validator anywhere in an initializer's source text. */
const ANY_VALIDATOR_RE = /\bv\.any\s*\(/u;
/** Matches a `v.string()` validator anywhere in an initializer's source text. */
const STRING_VALIDATOR_RE = /\bv\.string\s*\(/u;

/** True for a property initializer that is (or wraps) a `v.any()` validator. */
const isAnyValidator = (text: string): boolean => ANY_VALIDATOR_RE.test(text);

/** True for a `v.string()` validator (possibly `v.optional(v.string())`) with no length/max bound. */
const isUnboundedString = (text: string): boolean => STRING_VALIDATOR_RE.test(text) && !BOUND_RE.test(text);

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

            const text = initializer.getText();
            const name = property.getName();

            if (isAnyValidator(text)) {
                anyArgs.push(name);
            } else if (isUnboundedString(text)) {
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
 * args with no `.check()`/`.meta()` length bound (a DoS / storage-abuse vector —
 * the `unbounded_string_arg` lint). Only procedures with at least one flagged arg
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
