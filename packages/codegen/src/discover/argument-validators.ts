import type { ObjectLiteralExpression, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node } from "ts-morph";

import type { ArgumentValidatorIR, ValidatorIR } from "../ir";
import { parseValidator } from "../parse-validator";
import { procedureArgumentObjects } from "../procedure-argument-objects";
import { listLunoraSourceFiles, lunoraRelativePath } from "./ast";
import { classifyProcedureCall } from "./functions/classify-procedure-call";

/**
 * The refinements that cap a string's length at runtime. Nothing else counts:
 * `.meta({ maxLength })` is pure metadata the parser never enforces, `.min()`
 * bounds the wrong end, and a bare `.check()` may predicate anything — so a
 * `.check((s) => s.length <= n)` is over-reported rather than trusted.
 */
const LENGTH_BOUNDS = new Set(["length", "max"]);

/** The validators nested directly inside `node` (optional/array inner, record key/value, union members, object fields). */
const children = (node: ValidatorIR): ValidatorIR[] =>
    [node.inner, node.keyType, node.valueType, ...(node.members ?? []), ...Object.values(node.shape ?? {})].filter((child) => child !== undefined);

/** True when `node`, or any validator nested inside it, satisfies `predicate`. */
const contains = (node: ValidatorIR, predicate: (candidate: ValidatorIR) => boolean): boolean =>
    predicate(node) || children(node).some((child) => contains(child, predicate));

/** A `v.any()` proper — not the `{ kind: "any", sourceText }` fallback for an expression the parser could not read. */
const isAny = (node: ValidatorIR): boolean => node.kind === "any" && node.sourceText === undefined;

/** A `v.string()` with no length-capping refinement chained onto it. */
const isUnboundedString = (node: ValidatorIR): boolean => node.kind === "string" && !node.refinements?.some((refinement) => LENGTH_BOUNDS.has(refinement));

/**
 * Classify every arg property across the given object literals into any-typed
 * and unbounded-string buckets. Decided on the parsed {@link ValidatorIR}, never
 * on the initializer's source text: a substring test concluded "bounded" from
 * `.meta(…)`, from any `.check(…)`, and from the word `max` inside a description.
 */
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

            const validator = parseValidator(initializer);
            const name = property.getName();

            if (contains(validator, isAny)) {
                anyArgs.push(name);
            } else if (contains(validator, isUnboundedString)) {
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
 * args with no `.max(n)` / `.length(n)` bound (a DoS / storage-abuse vector —
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
