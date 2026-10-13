/**
 * Atomic field operators for `patch`: `{ increment: 1 }`, `{ decrement: 1 }`,
 * `{ multiply: 2 }`, `{ divide: 2 }` on a number column and `{ toggle: true }` on
 * a boolean one, in place of a literal value.
 *
 * Whether `{ increment: 1 }` is an operator or a plain value is decided by the
 * COLUMN's kind, never by the value's shape: an `any`/`object` column can
 * legitimately hold exactly that object, and a number column can hold nothing
 * but a number. Only `number` and `boolean` columns interpret operators.
 *
 * The result is computed against the row as the write sees it, so it is atomic
 * wherever the write is: a Durable Object runs one mutation at a time, and the
 * SQL store re-reads and re-resolves when its version check misses.
 *
 * It lives in `shared/` because the DO row store, the `.global()` store and the
 * RLS write gate all need the same rule and none depends on another. Inlined by
 * the bundler; keep it dependency-free.
 */
import { expandFieldPaths, FieldPathError } from "./json-field-path";
import { isPlainObject } from "./wire-codec";

/** What a column has to be for an operator to apply to it. */
type OperatorKind = "boolean" | "number";

interface OperatorSpec {
    /** The new value, from the stored one and the operand. Absent for `toggle`, which takes no arithmetic. */
    readonly apply?: (current: number, operand: number) => number;
    readonly kind: OperatorKind;
}

const OPERATORS = {
    decrement: { apply: (current, operand) => current - operand, kind: "number" },
    divide: { apply: (current, operand) => current / operand, kind: "number" },
    increment: { apply: (current, operand) => current + operand, kind: "number" },
    multiply: { apply: (current, operand) => current * operand, kind: "number" },
    toggle: { kind: "boolean" },
} as const satisfies Record<string, OperatorSpec>;

type OperatorName = keyof typeof OPERATORS;

/** Thrown for an operator that cannot be applied; the caller rethrows it as its own error type. */
class FieldOperatorError extends Error {}

/** `{ [operator]: operand }` when `value` is a plain object with exactly one operator key. */
const readOperator = (value: unknown): { operand: unknown; operator: OperatorName } | undefined => {
    if (!isPlainObject(value)) {
        return undefined;
    }

    const keys = Object.keys(value);
    const [operator] = keys;

    if (keys.length !== 1 || operator === undefined || !Object.hasOwn(OPERATORS, operator)) {
        return undefined;
    }

    return { operand: value[operator], operator: operator as OperatorName };
};

/** Is this value shaped like an operator? Kind-blind: an `object` column may legitimately hold exactly that object. */
const isFieldOperator = (value: unknown): boolean => readOperator(value) !== undefined;

const applyOperator = (field: string, operator: OperatorName, operand: unknown, current: unknown): unknown => {
    const spec: OperatorSpec = OPERATORS[operator];

    if (spec.apply === undefined) {
        if (operand !== true) {
            throw new FieldOperatorError(`patch: use { toggle: true } on "${field}".`);
        }

        if (typeof current !== "boolean") {
            throw new FieldOperatorError(`patch: cannot toggle "${field}" — its current value is ${String(current)}; set a boolean first.`);
        }

        return !current;
    }

    if (typeof operand !== "number" || !Number.isFinite(operand)) {
        throw new FieldOperatorError(`patch: "${operator}" on "${field}" needs a finite number, got ${String(operand)}.`);
    }

    if (typeof current !== "number" || !Number.isFinite(current)) {
        throw new FieldOperatorError(`patch: cannot ${operator} "${field}" — its current value is ${String(current)}; set a number first.`);
    }

    if (operator === "divide" && operand === 0) {
        throw new FieldOperatorError(`patch: cannot divide "${field}" by zero.`);
    }

    const result = spec.apply(current, operand);

    if (!Number.isFinite(result)) {
        throw new FieldOperatorError(`patch: "${operator}" on "${field}" overflows to ${String(result)}.`);
    }

    return result;
};

/**
 * The fields of `patch` whose value is an operator, for the column kind `kindOf` reports. Never throws, and
 * resolves nothing: it answers "is this field relative to the stored row?" for a caller (a staleness check, a
 * retry policy) that does not want the arithmetic.
 */
const operatorFields = (patch: Record<string, unknown>, kindOf: (field: string) => OperatorKind | undefined): ReadonlySet<string> => {
    const fields = new Set<string>();

    for (const [field, value] of Object.entries(patch)) {
        const kind = kindOf(field);

        if (kind !== undefined && isFieldOperator(value)) {
            fields.add(field);
        }
    }

    return fields;
};

/**
 * Replace each operator in `patch` with the value it produces against `current`, deciding what is an operator
 * from the column kind `kindOf` reports. A field that is not an operator for its column keeps its value.
 * @throws FieldOperatorError when an operator cannot be applied to the row's value.
 */
const resolveFieldOperators = (
    patch: Record<string, unknown>,
    current: Record<string, unknown>,
    kindOf: (field: string) => OperatorKind | undefined,
): Record<string, unknown> => {
    let resolved: Record<string, unknown> | undefined;

    for (const field of operatorFields(patch, kindOf)) {
        const { operand, operator } = readOperator(patch[field]) as NonNullable<ReturnType<typeof readOperator>>;
        const kind = kindOf(field);

        if (OPERATORS[operator].kind !== kind) {
            throw new FieldOperatorError(`patch: "${operator}" does not apply to the ${String(kind)} column "${field}".`);
        }

        resolved ??= { ...patch };
        resolved[field] = applyOperator(field, operator, operand, current[field]);
    }

    return resolved ?? patch;
};

/**
 * The patch as the store will apply it, resolved without a schema, for a layer that only holds the row: the RLS
 * write gate previewing the post-image a policy is checked against, and the client applying a plan to its local
 * copy. The kind of an operator column is taken from the row's current value. Each field is resolved on its own
 * and one that cannot be applied is left as it was, since the store that performs the write is authoritative and
 * raises the error; dotted paths are folded into their columns the same way.
 */
const previewPatch = (patch: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> => {
    const kindOf = (field: string): OperatorKind | undefined => {
        const value = current[field];

        return typeof value === "number" || typeof value === "boolean" ? (typeof value as OperatorKind) : undefined;
    };
    const resolved: Record<string, unknown> = { ...patch };

    for (const field of operatorFields(patch, kindOf)) {
        try {
            Object.assign(resolved, resolveFieldOperators({ [field]: patch[field] }, current, kindOf));
        } catch (error) {
            if (!(error instanceof FieldOperatorError)) {
                throw error;
            }
        }
    }

    try {
        return expandFieldPaths(resolved, current);
    } catch (error) {
        if (error instanceof FieldPathError) {
            return resolved;
        }

        throw error;
    }
};

export type { OperatorKind };
export { FieldOperatorError, isFieldOperator, operatorFields, previewPatch, resolveFieldOperators };
