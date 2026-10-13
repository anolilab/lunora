import { LunoraError } from "@lunora/errors";

import { effectiveKind } from "../../../shared/effective-kind";
import type { OperatorKind } from "../../../shared/field-operators";
import { FieldOperatorError, isFieldOperator, operatorFields as sharedOperatorFields, resolveFieldOperators } from "../../../shared/field-operators";
import { expandFieldPaths, FieldPathError, isFieldPath, readFieldPath, splitFieldPath } from "../../../shared/json-field-path";
import type { PatchWriteOptions, TableDefinitionLike, ValidatorLike } from "./schema-types";

/** Kinds whose stored value is a plain JS number: `v.timestamp()` and `v.date()` hold epoch milliseconds. */
const NUMBER_KINDS: ReadonlySet<string> = new Set(["date", "number", "timestamp"]);

/** The node a `v.optional(...)` wraps, else the node itself. */
const unwrapOptional = (validator: ValidatorLike): ValidatorLike =>
    validator.kind === "optional" && validator._meta?.inner !== undefined ? unwrapOptional(validator._meta.inner) : validator;

/**
 * Which operators a column takes: `"number"` or `"boolean"`, or `undefined` for a column that stores whatever it
 * is given. Looks through `v.optional(...)` and through a `v.union(...)` whose non-null members all agree, so the
 * Convex-style nullable number (`v.union(v.number(), v.null())`) counts. A literal column does not: it is
 * constrained to its value, and an operator would only compute one it then rejects.
 */
const operatorKind = (validator: ValidatorLike): OperatorKind | undefined => {
    const target = unwrapOptional(validator);

    if (target.kind !== undefined && NUMBER_KINDS.has(target.kind)) {
        return "number";
    }

    if (target.kind === "boolean") {
        return "boolean";
    }

    if (target.kind !== "union") {
        return undefined;
    }

    const kinds = new Set((target._meta?.members ?? []).filter((member) => effectiveKind(member) !== "null").map((member) => operatorKind(member)));
    const [only] = kinds;

    return kinds.size === 1 ? only : undefined;
};

const kindOfField = (definition: TableDefinitionLike) => (field: string) => {
    const validator = Object.hasOwn(definition.shape, field) ? definition.shape[field] : undefined;

    return validator === undefined ? undefined : operatorKind(validator);
};

/**
 * The fields of `patch` that are atomic operators for this table's columns. Never throws and resolves nothing, so a
 * check that only needs to know a field is relative to the stored row (a staleness check, a retry policy) does not
 * pay for the arithmetic or inherit its errors.
 */
const operatorFields = (definition: TableDefinitionLike, patch: Record<string, unknown>): ReadonlySet<string> =>
    sharedOperatorFields(patch, kindOfField(definition));

/**
 * Replace the atomic field operators in a `patch` (`{ increment: 1 }`, `{ toggle: true }`, …) with the values they
 * produce against `current`, the row as the write is about to see it. A patch with no operators comes back as the
 * same object. Both stores call this before merging, so the rule is written once.
 * @throws LunoraError `VALIDATION_ERROR` when an operator cannot be applied.
 */
const resolvePatchOperators = (definition: TableDefinitionLike, patch: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> => {
    try {
        return resolveFieldOperators(patch, current, kindOfField(definition));
    } catch (error) {
        if (error instanceof FieldOperatorError) {
            throw new LunoraError("VALIDATION_ERROR", error.message);
        }

        throw error;
    }
};

/** A path error as the `VALIDATION_ERROR` a caller sees. */
const pathError = (error: unknown): never => {
    if (error instanceof FieldPathError) {
        throw new LunoraError("VALIDATION_ERROR", error.message);
    }

    throw error;
};

/**
 * The fields of an object column, looking through `v.optional(...)` and through a `v.union(...)` that is one object
 * plus `null` (the Convex-style nullable object); `undefined` when the column is not such an object.
 */
const objectFieldsOf = (validator: ValidatorLike | undefined): Readonly<Record<string, ValidatorLike>> | undefined => {
    if (validator === undefined) {
        return undefined;
    }

    const target = unwrapOptional(validator);

    if (target.kind === "object") {
        return target._meta?.shape;
    }

    if (target.kind !== "union") {
        return undefined;
    }

    const objects = (target._meta?.members ?? []).filter((member) => effectiveKind(member) !== "null");

    return objects.length === 1 ? objectFieldsOf(objects[0]) : undefined;
};

/** The validator at the end of a path through nested `v.object` fields, or `undefined` when a step names no field. */
const leafValidatorOf = (definition: TableDefinitionLike, segments: ReadonlyArray<string>): ValidatorLike | undefined => {
    let validator: ValidatorLike | undefined = definition.shape[segments[0] ?? ""];

    for (const segment of segments.slice(1)) {
        const fields = objectFieldsOf(validator);

        validator = fields !== undefined && Object.hasOwn(fields, segment) ? fields[segment] : undefined;
    }

    return validator;
};

/**
 * Check one dotted patch key against the schema: every step must name a field of a nested `v.object`, and the
 * value must satisfy the validator at the end. A path the schema does not declare, or one through a column that
 * is not an object, is refused rather than written — a typo would otherwise create a stray key.
 * @throws LunoraError `VALIDATION_ERROR`
 */
const assertPathPatchable = (definition: TableDefinitionLike, field: string, value: unknown): void => {
    let segments: string[] = [];

    try {
        segments = splitFieldPath(field);
    } catch (error) {
        pathError(error);
    }

    const validator = leafValidatorOf(definition, segments);

    if (validator === undefined) {
        throw new LunoraError("VALIDATION_ERROR", `patch: "${field}" is not a path into an object column of this table`);
    }

    // A nested operator would be stored as the object it looks like: operators address whole columns.
    if (operatorKind(validator) !== undefined && isFieldOperator(value)) {
        throw new LunoraError("VALIDATION_ERROR", `patch: "${field}" is nested inside a column; operators like increment apply to a top-level column only`);
    }

    if (typeof validator.parse === "function") {
        try {
            validator.parse(value);
        } catch (error) {
            throw new LunoraError("VALIDATION_ERROR", `patch: "${field}" ${error instanceof Error ? error.message : "is invalid"}`);
        }
    }
};

/**
 * Fold the dotted keys of a patch into their columns (`{ "profile.plan": "pro" }` → `{ profile: { …, plan: "pro" } }`),
 * leaving the object's other keys as they are. Each path is checked against the schema first.
 */
const expandPatchPaths = (definition: TableDefinitionLike, patch: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> => {
    for (const [field, value] of Object.entries(patch)) {
        if (isFieldPath(field)) {
            assertPathPatchable(definition, field, value);
        }
    }

    try {
        return expandFieldPaths(patch, current);
    } catch (error) {
        return pathError(error);
    }
};

/**
 * A patch as the store writes it: atomic operators applied against `current`, then dotted paths folded into their
 * columns. Both stores call this once, before merging, so the rule is written once. A patch with neither comes back
 * as the same object.
 * @throws LunoraError `VALIDATION_ERROR` when an operator or a path cannot be applied.
 */
const resolvePatch = (definition: TableDefinitionLike, patch: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> =>
    expandPatchPaths(definition, resolvePatchOperators(definition, patch, current), current);

/** Does what this patch writes depend on the row it lands on? True for an operator or a dotted path, which the store must re-read and re-apply after a lost race. */
const patchDependsOnRow = (definition: TableDefinitionLike, patch: Record<string, unknown>): boolean =>
    operatorFields(definition, patch).size > 0 || Object.keys(patch).some((field) => isFieldPath(field));

/**
 * Run the caller-supplied post-image check, if any, against the row about to be written.
 * @throws LunoraError `FORBIDDEN` when it says no. The message is table-agnostic on purpose.
 */
const assertPatchAllowed = (options: PatchWriteOptions | undefined, previous: Record<string, unknown>, next: Record<string, unknown>): void => {
    if (options?.verify !== undefined && !options.verify(previous, next)) {
        throw new LunoraError("FORBIDDEN", "update denied by policy");
    }
};

/** `readFieldPath` for a patch key, with a malformed path reported as the `VALIDATION_ERROR` a caller expects. */
const readPatchField = (document: Record<string, unknown>, field: string): unknown => {
    try {
        return readFieldPath(document, field);
    } catch (error) {
        return pathError(error);
    }
};

export { assertPatchAllowed, operatorFields, patchDependsOnRow, readPatchField, resolvePatch };
