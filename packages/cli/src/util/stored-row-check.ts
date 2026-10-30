/**
 * Check a deployment's stored rows against the schema about to ship, so the
 * drift gate can let a tightening through when the data already fits and refuse
 * an override when it does not.
 *
 * The deployed worker still runs the OLD schema, so the new validators are run
 * here, over rows read through the runtime's admin export route — the same route
 * on Cloudflare, Node and celld. A check that cannot be completed is never a pass.
 */
import type { DriftChange, TableIR, ValidatorIR } from "@lunora/codegen";
import { decodeWire } from "@lunora/wire";

import type { ExportTarget } from "../commands/data-transfer/export-rows";
import { forEachExportedRow } from "../commands/data-transfer/export-rows";

/**
 * The breaking changes whose verdict a row-by-row read decides. Each concerns one
 * field and makes a stored row invalid by that field alone. A unique column or index (a
 * duplicate is a property of two rows), a TTL, and the `addedFieldConstraint`
 * family (which mixes `.unique()` and refinements in with `.nullable()`) are not
 * decidable that way and keep the gate's answer.
 */
const ROW_CHECKABLE_CHANGES = new Set<DriftChange["type"]>([
    "addedRequiredField",
    "changedFieldKind",
    "changedFieldShape",
    "fieldOptionalToRequired",
    "removedField",
]);

const isRowCheckable = (change: DriftChange): change is DriftChange & { field: string; table: string } =>
    change.table !== undefined && change.field !== undefined && ROW_CHECKABLE_CHANGES.has(change.type);

/** Rows named in a failing verdict. Enough to act on, few enough to read in a CI log. */
const FAILURE_SAMPLE = 10;

interface StoredRowFailure {
    /** Dot path of the offending field, or `(row)` for a row-level problem. */
    field: string;
    id: string;

    /**
     * What was expected and what type was found. Never a stored value, and never a
     * key that is data (a record key, an undeclared property): either can be sensitive.
     */
    reason: string;
    table: string;
}

type StoredRowVerdict =
    | { failures: StoredRowFailure[]; kind: "fails"; rows: number; truncated: boolean }
    | { kind: "conforms"; rows: number; tables: string[] }
    | { kind: "inconclusive"; reason: string };

/** Whether `validator` holds a `v.id()` or `v.storage()` anywhere. */
const referencesRow = (validator: ValidatorIR): boolean =>
    validator.kind === "id" ||
    validator.kind === "storage" ||
    [validator.inner, validator.keyType, validator.valueType, ...(validator.members ?? []), ...Object.values(validator.shape ?? {})].some(
        (child) => child !== undefined && referencesRow(child),
    );

const typeName = (value: unknown): string => {
    if (value === null) {
        return "null";
    }

    if (Array.isArray(value)) {
        return "array";
    }

    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return "bytes";
    }

    return typeof value;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeName(value) === "object";

const BIGINT_LITERAL = /^-?\d+n$/u;

/** A `v.literal()` source text as the value it denotes. */
const literalOf = (text: string): unknown => {
    const trimmed = text.trim();

    if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed.slice(1, -1);
    }

    // `JSON.parse` has no bigint literal, and a stored bigint reads back as a bigint.
    if (BIGINT_LITERAL.test(trimmed)) {
        return BigInt(trimmed.slice(0, -1));
    }

    try {
        return JSON.parse(trimmed);
    } catch {
        return trimmed;
    }
};

const isFiniteNumber = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);

const inRange = (value: unknown, limit: number): boolean => isFiniteNumber(value) && Math.abs(value as number) <= limit;

const SCALAR_CHECKS: Record<string, (value: unknown) => boolean> = {
    any: () => true,
    bigint: (value) => typeof value === "bigint",
    boolean: (value) => typeof value === "boolean",
    bytes: (value) => value instanceof ArrayBuffer || ArrayBuffer.isView(value),
    date: isFiniteNumber,
    // The ranges `v.geoPoint()` enforces on write.
    geoPoint: (value) => isPlainRecord(value) && inRange(value["lat"], 90) && inRange(value["lng"], 180),
    id: (value) => typeof value === "string",
    null: (value) => value === null,
    number: isFiniteNumber,
    storage: (value) => typeof value === "string",
    string: (value) => typeof value === "string",
    timestamp: isFiniteNumber,
};

type Mismatch = [path: string, reason: string] | undefined;

/** The first of `entries` whose value does not fit `validator`. */
const firstMismatch = (entries: Iterable<[string, unknown]>, validator: ValidatorIR | undefined, path: (key: string) => string): Mismatch => {
    if (validator === undefined) {
        return undefined;
    }

    for (const [key, item] of entries) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: container items re-enter `mismatch`
        const found = mismatch(item, validator, path(key));

        if (found !== undefined) {
            return found;
        }
    }

    return undefined;
};

/** The checks for the validator kinds that contain other values, keyed by kind. */
const COMPOSITE_CHECKS: Record<string, (value: unknown, validator: ValidatorIR, path: string) => Mismatch> = {
    array: (value, validator, path) =>
        Array.isArray(value)
            ? firstMismatch(
                  value.map((item, index): [string, unknown] => [String(index), item]),
                  validator.inner,
                  (index) => `${path}[${index}]`,
              )
            : [path, `expected array, found ${typeName(value)}`],
    literal: (value, validator, path) =>
        value === literalOf(validator.literalValue ?? "")
            ? undefined
            : [path, `expected the literal ${validator.literalValue ?? "?"}, found a different ${typeName(value)}`],
    object: (value, validator, path) =>
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: object properties re-enter `mismatch`
        isPlainRecord(value) ? shapeMismatch(value, validator.shape ?? {}, `${path}.`) : [path, `expected object, found ${typeName(value)}`],
    // A key is checked as a value of its key validator, but reported as `[*]`: record keys are data, not schema.
    record: (value, validator, path) =>
        isPlainRecord(value)
            ? (firstMismatch(
                  Object.keys(value).map((key): [string, unknown] => [key, key]),
                  validator.keyType,
                  () => `${path}[*]`,
              ) ?? firstMismatch(Object.entries(value), validator.valueType, () => `${path}[*]`))
            : [path, `expected record, found ${typeName(value)}`],
    union: (value, validator, path) =>
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: each member re-enters `mismatch`
        (validator.members ?? []).some((member) => mismatch(value, member, path) === undefined)
            ? undefined
            : [path, `matches no member of the union (found ${typeName(value)})`],
};

/** Why `value` does not fit a scalar `validator`, or `undefined` when it does. */
const scalarMismatch = (value: unknown, validator: ValidatorIR, path: string, accepts: (value: unknown) => boolean): Mismatch => {
    if (!accepts(value)) {
        return [path, `expected ${validator.kind}, found ${typeName(value)}`];
    }

    return typeof value === "string" && validator.stringMaxLength !== undefined && value.length > validator.stringMaxLength
        ? [path, `longer than ${String(validator.stringMaxLength)} characters`]
        : undefined;
};

/** Why `value` does not fit `validator`, as `[path, reason]`, or `undefined` when it does. */
const mismatch = (value: unknown, validator: ValidatorIR, path: string): Mismatch => {
    if (value === null && validator.column?.notNull === false) {
        return undefined;
    }

    if (validator.kind === "optional") {
        return value === undefined || validator.inner === undefined ? undefined : mismatch(value, validator.inner, path);
    }

    if (value === undefined) {
        return [path, "required, but missing"];
    }

    const scalar = SCALAR_CHECKS[validator.kind];

    if (scalar !== undefined) {
        return scalarMismatch(value, validator, path, scalar);
    }

    const composite = COMPOSITE_CHECKS[validator.kind];

    return composite === undefined ? [path, `has a \`${validator.kind}\` validator this check does not know`] : composite(value, validator, path);
};

/** The first property of a `v.object()` value that does not fit `shape`, including an undeclared one. */
const shapeMismatch = (document: Record<string, unknown>, shape: Record<string, ValidatorIR>, prefix: string): Mismatch => {
    // The key itself is not reported: under a `v.record()` (or from a careless write) it is data, not schema.
    if (Object.keys(document).some((key) => !Object.hasOwn(shape, key))) {
        return [`${prefix}*`, "holds a property the schema does not declare"];
    }

    for (const [key, validator] of Object.entries(shape)) {
        const found = mismatch(document[key], validator, `${prefix}${key}`);

        if (found !== undefined) {
            return found;
        }
    }

    return undefined;
};

/** A validator whose accepted values this checker cannot reproduce, or `undefined` when it can. */
const unverifiable = (validator: ValidatorIR, path: string): string | undefined => {
    // `sourceText` marks an expression codegen could not resolve to a validator (it reads as `v.any()`), and a refinement
    // other than a literal `.max(n)` is a closure the IR cannot run.
    if (
        validator.sourceText !== undefined ||
        validator.unmodelledRefinement === true ||
        validator.unresolvedShape === true ||
        (validator.hasRefinement === true && validator.stringMaxLength === undefined)
    ) {
        return `${path} has a validator or refinement that cannot be checked outside the worker`;
    }

    if (validator.kind === "from") {
        return `${path} is a \`v.from()\` schema, which cannot be checked outside the worker`;
    }

    if (validator.kind !== "optional" && SCALAR_CHECKS[validator.kind] === undefined && COMPOSITE_CHECKS[validator.kind] === undefined) {
        return `${path} has a \`${validator.kind}\` validator this check does not know`;
    }

    const children = [validator.inner, validator.keyType, validator.valueType, ...(validator.members ?? []), ...Object.values(validator.shape ?? {})];

    for (const child of children) {
        const found = child === undefined ? undefined : unverifiable(child, path);

        if (found !== undefined) {
            return found;
        }
    }

    return undefined;
};

/** What to check on one table: the changed fields that must fit their new validator, and the removed ones that must be gone. */
interface TablePlan {
    removed: string[];
    table: TableIR;
    validated: [string, ValidatorIR][];
}

/**
 * A stored field's value as the new schema would read it: wire tags decoded and,
 * on a `.global()` table (whose columns store an unset optional as SQL NULL), a
 * NULL in an optional, non-nullable field read as absent.
 */
const storedValue = (table: TableIR, field: string, validator: ValidatorIR, document: Record<string, unknown>): unknown => {
    const value = decodeWire(document[field]);

    return table.shardMode === "global" && value === null && validator.kind === "optional" && validator.column?.notNull !== false ? undefined : value;
};

/** The first changed field of `document` that does not fit, as `[path, reason]`. */
const rowMismatch = (plan: TablePlan, document: Record<string, unknown>): Mismatch => {
    // A `.global()` column that was never set is stored, and exported, as SQL NULL, so it does not hold a value.
    const unset = (field: string): boolean => document[field] === undefined || (plan.table.shardMode === "global" && document[field] === null);
    const removed = plan.removed.find((field) => !unset(field));

    if (removed !== undefined) {
        return [removed, "is no longer declared, but the row still holds it"];
    }

    for (const [field, validator] of plan.validated) {
        const found = mismatch(storedValue(plan.table, field, validator, document), validator, field);

        if (found !== undefined) {
            return found;
        }
    }

    return undefined;
};

/** What to check per table, or why these changes cannot be decided by reading rows. */
const planCheck = (changes: ReadonlyArray<DriftChange>, tables: ReadonlyMap<string, TableIR>): { plans: Map<string, TablePlan> } | { reason: string } => {
    const plans = new Map<string, TablePlan>();

    for (const change of changes) {
        if (!isRowCheckable(change)) {
            return { reason: `"${change.summary}" is not something stored rows can confirm` };
        }

        const { field, table: name } = change;
        const table = tables.get(name);

        if (table === undefined) {
            return { reason: `table ${name} is not in the current schema` };
        }

        const plan = plans.get(name) ?? { removed: [], table, validated: [] };

        plans.set(name, plan);

        const validator = table.shape[field];

        if (change.type === "removedField" || validator === undefined) {
            plan.removed.push(field);
            continue;
        }

        // A stored string cannot show which table a `v.id()` points at or which bucket a `v.storage()` key lives in.
        const reason =
            (change.type === "changedFieldKind" || change.type === "changedFieldShape") && referencesRow(validator)
                ? `${name}.${field} now references a different table or bucket, which a stored id cannot show`
                : unverifiable(validator, `${name}.${field}`);

        if (reason !== undefined) {
            return { reason };
        }

        plan.validated.push([field, validator]);
    }

    return { plans };
};

/**
 * Read every stored row of the tables `changes` touch and check each changed
 * field against the new schema. Bounded in what it reports, not in what it
 * reads: "conforms" needs every row, so the read stops early only once
 * {@link FAILURE_SAMPLE} failures are in hand.
 */
const checkStoredRows = async (options: {
    changes: ReadonlyArray<DriftChange>;
    tables: ReadonlyArray<TableIR>;
    target: ExportTarget | undefined;
}): Promise<StoredRowVerdict> => {
    const planned = planCheck(options.changes, new Map(options.tables.map((table) => [table.name, table])));

    if ("reason" in planned) {
        return { kind: "inconclusive", reason: planned.reason };
    }

    const { plans } = planned;

    if (options.target === undefined) {
        return {
            kind: "inconclusive",
            reason: "no deployed worker to read the stored rows from — pass --migrate-url (or record one with `lunora link`) and set LUNORA_ADMIN_TOKEN",
        };
    }

    const names = [...plans.keys()].toSorted((a, b) => a.localeCompare(b));
    const failures: StoredRowFailure[] = [];
    let rows = 0;
    let truncated = false;

    try {
        await forEachExportedRow(options.target, names, (row) => {
            const plan = plans.get(row.table);

            if (plan === undefined) {
                return undefined;
            }

            rows += 1;

            const found = rowMismatch(plan, row.doc);

            if (found === undefined) {
                return undefined;
            }

            if (failures.length === FAILURE_SAMPLE) {
                truncated = true;

                return false;
            }

            failures.push({
                field: found[0],
                id: typeof row.doc["_id"] === "string" ? row.doc["_id"] : "(no _id)",
                reason: found[1],
                table: row.table,
            });

            return undefined;
        });
    } catch (error: unknown) {
        return { kind: "inconclusive", reason: error instanceof Error ? error.message : String(error) };
    }

    return failures.length === 0 ? { kind: "conforms", rows, tables: names } : { failures, kind: "fails", rows, truncated };
};

/** One line per failing row, for the gate's message. */
const describeFailures = (verdict: Extract<StoredRowVerdict, { kind: "fails" }>): string =>
    [
        `${String(verdict.failures.length)}${verdict.truncated ? "+" : ""} stored row(s) do not fit the new schema${verdict.truncated ? ` (the first ${String(FAILURE_SAMPLE)} shown)` : ""}:`,
        ...verdict.failures.map((failure) => `  - ${failure.table} ${failure.id}: ${failure.field} ${failure.reason}`),
    ].join("\n");

export type { StoredRowVerdict };
export { checkStoredRows, describeFailures, isRowCheckable };
