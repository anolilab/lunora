import { LunoraError } from "@lunora/errors";

import { effectiveKind } from "../../../shared/effective-kind";
import type { OperatorKind } from "../../../shared/field-operators";
import { FieldOperatorError, operatorFields as sharedOperatorFields, resolveFieldOperators } from "../../../shared/field-operators";
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

/**
 * Run the caller-supplied post-image check, if any, against the row about to be written.
 * @throws LunoraError `FORBIDDEN` when it says no. The message is table-agnostic on purpose.
 */
const assertPatchAllowed = (options: PatchWriteOptions | undefined, previous: Record<string, unknown>, next: Record<string, unknown>): void => {
    if (options?.verify !== undefined && !options.verify(previous, next)) {
        throw new LunoraError("FORBIDDEN", "update denied by policy");
    }
};

export { assertPatchAllowed, operatorFields, resolvePatchOperators };
