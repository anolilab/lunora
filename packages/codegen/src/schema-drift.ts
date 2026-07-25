/**
 * Schema-drift detection for the pre-deploy gate.
 *
 * Lunora's `defineSchema` (tables/indexes/relations) is applied to each DO's
 * SQLite at runtime, and `defineMigration` declarations are hand-written DATA
 * migrations — there is no schema→migration-file mapping to diff the way a
 * Drizzle/Prisma stack would. So instead of regenerating migration DDL, this
 * module captures a deterministic STRUCTURAL snapshot of the schema (per table:
 * field kinds + optionality, indexes, relations, shard mode) plus the set of
 * declared migration ids, and diffs the current schema against a COMMITTED
 * baseline (`lunora/.lunora-schema.json`).
 *
 * Each change is classified `safe` (additive — new table, new optional field,
 * added index/relation, a required field made optional) or `breaking` (needs a
 * data migration — dropped table/field, field-kind change, optional→required,
 * a new REQUIRED field on an existing table, a changed shard mode, a
 * removed/renamed index or relation). The CLI gate (`lunora deploy`/`verify`/
 * `prepare`) blocks a deploy when there is breaking drift AND no NEW migration
 * id has been added since the baseline — the footgun this closes is shipping a
 * schema change that needs a backfill with no migration to perform it.
 *
 * Everything here is pure (no I/O) so it is unit-testable; the CLI owns reading
 * and writing the baseline file.
 */
import { LunoraError } from "@lunora/errors";

import type { SchemaIR, TableIR, ValidatorIR } from "./ir";

/** Current snapshot format version. Bumped if the structural shape below changes. */
const SCHEMA_SNAPSHOT_VERSION = 1 as const;

/** A single field's structural shape: its value kind and whether it is optional. */
interface FieldSnapshot {
    /** The validator kind (`string`, `number`, `id`, `object`, …) after unwrapping `v.optional`. */
    kind: string;
    /** True when declared `v.optional(...)` — accepts `undefined` / absent on insert. */
    optional: boolean;
}

/** A single secondary index's structural shape. */
interface IndexSnapshot {
    fields: ReadonlyArray<string>;
    unique: boolean;
}

/** A single relation's structural shape. */
interface RelationSnapshot {
    field: string;
    kind: "many" | "one";
    table: string;
}

/** Structural snapshot of one table. */
interface TableSnapshot {
    /** Field name → {@link FieldSnapshot}, in declared order. */
    fields: Record<string, FieldSnapshot>;
    /** Index name → {@link IndexSnapshot}. */
    indexes: Record<string, IndexSnapshot>;
    /** Relation accessor name → {@link RelationSnapshot}. */
    relations: Record<string, RelationSnapshot>;

    /**
     * `"root"` (default single-DO), `"global"` (D1-replicated), or
     * `"shardBy:&lt;field>"` (partitioned). Encoded as a string so the snapshot
     * stays a plain JSON-stable value.
     */
    shardMode: string;
}

/** The committed baseline — a deterministic structural view of the whole schema. */
interface SchemaSnapshot {
    /**
     * Cloudflare DO data-residency jurisdiction declared via `.jurisdiction("…")`,
     * or absent. Tracked because changing it strands all existing Durable Object
     * data (a DO name maps to a different ID per jurisdiction). Optional, so old
     * baselines written before this field parse cleanly (absent ⇒ undefined).
     *
     * Typed as a plain `string` (not the authoring union) on purpose: this is
     * STORED data that a newer Lunora may have written with a jurisdiction this
     * version doesn't yet know. Preserving the raw value keeps the breaking
     * `changedJurisdiction` diff correct under a downgrade — coercing an unknown
     * value to `undefined` would fail OPEN and hide the most destructive change.
     */
    jurisdiction?: string;
    /** Sorted list of every declared `defineMigration` id at capture time. */
    migrationIds: ReadonlyArray<string>;
    /** Table name → {@link TableSnapshot}, keys sorted for stable serialization. */
    tables: Record<string, TableSnapshot>;
    version: typeof SCHEMA_SNAPSHOT_VERSION;
}

/** One classified structural change between the baseline and the current schema. */
interface DriftChange {
    /** `"breaking"` changes need a data migration; `"safe"` changes are additive. */
    severity: "breaking" | "safe";
    /** Human-readable, actionable description (used in the gate message). */
    summary: string;
    /** A machine-readable change discriminator. */
    type:
        | "addedIndex"
        | "addedOptionalField"
        | "addedRelation"
        | "addedRequiredField"
        | "addedTable"
        | "changedJurisdiction"
        | "changedFieldKind"
        | "changedIndex"
        | "changedShardMode"
        | "fieldOptionalToRequired"
        | "fieldRequiredToOptional"
        | "removedField"
        | "removedIndex"
        | "removedRelation"
        | "removedTable";
}

/** The result of diffing two snapshots: every classified change. */
interface SchemaDrift {
    /** Every classified change, in a stable order (added/changed per table, then removals). */
    changes: ReadonlyArray<DriftChange>;
}

/** Encode a `TableIR.shardMode` into the snapshot's stable string form. */
const encodeShardMode = (mode: TableIR["shardMode"]): string => {
    if (mode === "global" || mode === "root") {
        return mode;
    }

    return `shardBy:${mode.field}`;
};

/** Unwrap `v.optional(inner)` to `{ kind, optional }`. */
const fieldSnapshotOf = (validator: ValidatorIR): FieldSnapshot => {
    if (validator.kind === "optional") {
        return { kind: validator.inner?.kind ?? "unknown", optional: true };
    }

    return { kind: validator.kind, optional: false };
};

/** Build a deterministic structural snapshot of one table. */
const tableSnapshotOf = (table: TableIR): TableSnapshot => {
    const fields: Record<string, FieldSnapshot> = {};

    for (const [name, validator] of Object.entries(table.shape)) {
        fields[name] = fieldSnapshotOf(validator);
    }

    const indexes: Record<string, IndexSnapshot> = {};

    for (const index of table.indexes) {
        indexes[index.name] = { fields: [...index.fields], unique: index.unique ?? false };
    }

    const relations: Record<string, RelationSnapshot> = {};

    for (const relation of table.relations) {
        relations[relation.name] = { field: relation.field, kind: relation.kind, table: relation.table };
    }

    return { fields, indexes, relations, shardMode: encodeShardMode(table.shardMode) };
};

/**
 * Return a new object with its keys sorted, so JSON serialization is deterministic.
 *
 * Sorted by UTF-16 code unit, NOT `localeCompare`. `localeCompare` resolves
 * against the runtime's default locale and ICU version, so it is not stable
 * across machines — which defeats the entire purpose here: `.lunora-schema.json`
 * is a COMMITTED file, so a locale-sensitive ordering means two developers (or a
 * developer and CI, or one machine before and after a Node upgrade) can
 * regenerate the same schema and produce different bytes, showing up as a
 * spurious diff and a false drift signal.
 */
const sortKeys = <T>(record: Record<string, T>): Record<string, T> => {
    const sorted: Record<string, T> = {};
    const keys = Object.keys(record);

    // eslint-disable-next-line sonarjs/no-alphabetical-sort -- code-unit order is required for cross-machine byte stability; a localeCompare comparator is the bug, not the fix
    keys.sort();

    for (const key of keys) {
        sorted[key] = record[key] as T;
    }

    return sorted;
};

/**
 * Build a {@link SchemaSnapshot} from a parsed {@link SchemaIR} and the set of
 * declared migration ids. Tables and migration ids are sorted so the emitted
 * JSON is byte-stable across runs AND across machines (no spurious diffs /
 * churn) — see {@link sortKeys} for why that ordering must not be locale-aware.
 *
 * Field / index / relation keys are deliberately NOT sorted: they are emitted in
 * declaration order from the schema source, which is already deterministic for a
 * given source file and keeps the snapshot readable next to the schema it mirrors.
 */
const buildSchemaSnapshot = (schema: SchemaIR, migrationIds: ReadonlyArray<string>): SchemaSnapshot => {
    const tables: Record<string, TableSnapshot> = {};

    for (const table of schema.tables) {
        tables[table.name] = tableSnapshotOf(table);
    }

    // eslint-disable-next-line sonarjs/no-alphabetical-sort, unicorn/no-array-sort -- see `sortKeys`: code-unit order, not locale collation; the spread already copies
    const sortedMigrationIds = [...migrationIds].sort();

    return {
        jurisdiction: schema.jurisdiction,
        migrationIds: sortedMigrationIds,
        tables: sortKeys(tables),
        version: SCHEMA_SNAPSHOT_VERSION,
    };
};

/** Serialize a snapshot to the exact bytes written to `lunora/.lunora-schema.json` (trailing newline). */
const serializeSchemaSnapshot = (snapshot: SchemaSnapshot): string => `${JSON.stringify(snapshot, undefined, 2)}\n`;

/**
 * Thrown by {@link parseSchemaSnapshot} when the baseline file exists but is
 * malformed (bad JSON / wrong version / invalid table shape). Lets the CLI gate
 * treat a corrupt baseline as a hard error rather than silently degrading to a
 * "first capture" that would mask drift and then overwrite the bad file.
 */
class SchemaSnapshotParseError extends LunoraError {
    public constructor(message: string) {
        super("SCHEMA_SNAPSHOT_PARSE", message, { name: "SchemaSnapshotParseError" });
    }
}

/** True when `value` is a non-null object (the shape every snapshot sub-record must have). */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Structurally validate one parsed table entry, so a `version:1` file with garbage tables is rejected (not diffed). */
const isValidTableSnapshot = (value: unknown): value is TableSnapshot =>
    isRecord(value) && isRecord(value.fields) && isRecord(value.indexes) && isRecord(value.relations) && typeof value.shardMode === "string";

/**
 * Parse a committed snapshot file. Returns `undefined` ONLY when the content is
 * absent/empty; throws {@link SchemaSnapshotParseError} when content is present
 * but malformed (bad JSON, wrong version, or structurally-invalid tables) so the
 * caller can distinguish "no baseline yet" (a legitimate first capture) from "a
 * corrupt baseline" (which must not be silently treated as a first capture).
 */
const parseSchemaSnapshot = (content: string | undefined): SchemaSnapshot | undefined => {
    if (content === undefined || content.trim() === "") {
        return undefined;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(content);
    } catch (error: unknown) {
        throw new SchemaSnapshotParseError(`baseline is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!isRecord(parsed) || parsed.version !== SCHEMA_SNAPSHOT_VERSION || !isRecord(parsed.tables)) {
        throw new SchemaSnapshotParseError(`baseline is malformed or written by an incompatible version (expected version ${String(SCHEMA_SNAPSHOT_VERSION)})`);
    }

    for (const [name, table] of Object.entries(parsed.tables)) {
        if (!isValidTableSnapshot(table)) {
            throw new SchemaSnapshotParseError(`baseline table "${name}" has an invalid structure`);
        }
    }

    // `jurisdiction` is optional and was added after v1, so a baseline written
    // before it simply omits the key (parsed as `undefined`) — no version bump,
    // no forced re-bless. Preserve ANY string verbatim (not just the literals this
    // version knows): a newer baseline may carry a jurisdiction this code doesn't
    // recognise yet, and coercing it to `undefined` would fail open and suppress
    // the breaking `changedJurisdiction` diff on a downgrade.
    const jurisdiction = typeof parsed.jurisdiction === "string" ? parsed.jurisdiction : undefined;

    return {
        jurisdiction,
        migrationIds: Array.isArray(parsed.migrationIds) ? (parsed.migrationIds as ReadonlyArray<string>) : [],
        tables: parsed.tables as Record<string, TableSnapshot>,
        version: SCHEMA_SNAPSHOT_VERSION,
    };
};

/** Whether two index snapshots are structurally identical (ordered fields + unique flag). */
const indexesEqual = (a: IndexSnapshot, b: IndexSnapshot): boolean =>
    a.unique === b.unique && a.fields.length === b.fields.length && a.fields.every((field, index) => field === b.fields[index]);

/** Classify the change to a single field that exists in BOTH snapshots (kind change + optionality flip). */
const diffExistingField = (tableName: string, name: string, old: FieldSnapshot, field: FieldSnapshot): DriftChange[] => {
    const changes: DriftChange[] = [];

    if (old.kind !== field.kind) {
        changes.push({
            severity: "breaking",
            summary: `field ${tableName}.${name} changed type: ${old.kind} → ${field.kind} — add a data migration to convert existing values`,
            type: "changedFieldKind",
        });
    }

    if (old.optional && !field.optional) {
        changes.push({
            severity: "breaking",
            summary: `field ${tableName}.${name} became required — rows missing it would be invalid; add a data migration to backfill it`,
            type: "fieldOptionalToRequired",
        });
    } else if (!old.optional && field.optional) {
        changes.push({ severity: "safe", summary: `field ${tableName}.${name} became optional`, type: "fieldRequiredToOptional" });
    }

    return changes;
};

/** Classify a field present only in the CURRENT snapshot: optional ⇒ safe, required ⇒ needs a backfill. */
const addedFieldChange = (tableName: string, name: string, field: FieldSnapshot): DriftChange =>
    field.optional
        ? { severity: "safe", summary: `added optional field ${tableName}.${name}`, type: "addedOptionalField" }
        : {
              severity: "breaking",
              summary: `added required field ${tableName}.${name} — existing rows have no value; add a data migration to backfill it`,
              type: "addedRequiredField",
          };

/** Diff the fields of one table that exists in both snapshots. */
const diffFields = (tableName: string, baseline: TableSnapshot, current: TableSnapshot, changes: DriftChange[]): void => {
    for (const [name, field] of Object.entries(current.fields)) {
        const old = baseline.fields[name];

        if (old === undefined) {
            changes.push(addedFieldChange(tableName, name, field));
        } else {
            changes.push(...diffExistingField(tableName, name, old, field));
        }
    }

    for (const name of Object.keys(baseline.fields)) {
        if (current.fields[name] === undefined) {
            changes.push({
                severity: "breaking",
                summary: `removed field ${tableName}.${name} — add a data migration if stored data must be cleaned up`,
                type: "removedField",
            });
        }
    }
};

/** Diff the indexes of one table that exists in both snapshots. */
const diffIndexes = (tableName: string, baseline: TableSnapshot, current: TableSnapshot, changes: DriftChange[]): void => {
    for (const [name, index] of Object.entries(current.indexes)) {
        const old = baseline.indexes[name];

        if (old === undefined) {
            changes.push({ severity: "safe", summary: `added index ${name} on ${tableName}`, type: "addedIndex" });

            continue;
        }

        if (!indexesEqual(old, index)) {
            changes.push({
                severity: "breaking",
                summary: `index ${name} on ${tableName} changed shape — a query may have relied on the old index`,
                type: "changedIndex",
            });
        }
    }

    for (const name of Object.keys(baseline.indexes)) {
        if (current.indexes[name] === undefined) {
            changes.push({
                severity: "breaking",
                summary: `removed index ${name} on ${tableName} — a query that used \`.withIndex("${name}")\` would break`,
                type: "removedIndex",
            });
        }
    }
};

/** Diff the relations of one table that exists in both snapshots. */
const diffRelations = (tableName: string, baseline: TableSnapshot, current: TableSnapshot, changes: DriftChange[]): void => {
    for (const name of Object.keys(current.relations)) {
        if (baseline.relations[name] === undefined) {
            changes.push({ severity: "safe", summary: `added relation ${tableName}.${name}`, type: "addedRelation" });
        }
    }

    for (const name of Object.keys(baseline.relations)) {
        if (current.relations[name] === undefined) {
            changes.push({ severity: "breaking", summary: `removed relation ${tableName}.${name}`, type: "removedRelation" });
        }
    }
};

/** Diff one table that exists in both snapshots (shard mode, fields, indexes, relations). */
const diffExistingTable = (tableName: string, baseline: TableSnapshot, current: TableSnapshot, changes: DriftChange[]): void => {
    if (baseline.shardMode !== current.shardMode) {
        changes.push({
            severity: "breaking",
            summary: `table ${tableName} changed shard mode: ${baseline.shardMode} → ${current.shardMode} — its physical storage moves; add a data migration / re-shard plan`,
            type: "changedShardMode",
        });
    }

    diffFields(tableName, baseline, current, changes);
    diffIndexes(tableName, baseline, current, changes);
    diffRelations(tableName, baseline, current, changes);
};

/**
 * Diff the current snapshot against a committed baseline and classify every
 * structural change. Pure — no I/O. When `baseline` is `undefined` (no committed
 * snapshot yet) there is no drift to report: every table is treated as a fresh
 * additive `addedTable`, so a first deploy is never blocked.
 */
const diffSchemaSnapshots = (baseline: SchemaSnapshot | undefined, current: SchemaSnapshot): SchemaDrift => {
    const changes: DriftChange[] = [];
    const baselineTables = baseline?.tables ?? {};

    for (const [tableName, table] of Object.entries(current.tables)) {
        const old = baselineTables[tableName];

        if (old === undefined) {
            changes.push({ severity: "safe", summary: `added table ${tableName}`, type: "addedTable" });

            continue;
        }

        diffExistingTable(tableName, old, table, changes);
    }

    for (const tableName of Object.keys(baselineTables)) {
        if (current.tables[tableName] === undefined) {
            changes.push({
                severity: "breaking",
                summary: `removed table ${tableName} — add a data migration if its data must be archived/cleaned up`,
                type: "removedTable",
            });
        }
    }

    // A jurisdiction change re-homes every Durable Object: a DO name maps to a
    // different ID per jurisdiction, so the prior data is left in the old region
    // and becomes unreachable. There is no in-place migration, so this is the
    // most destructive change the gate can see — flag it breaking. Only compared
    // against an existing baseline (a first-ever capture is never drift).
    if (baseline !== undefined && baseline.jurisdiction !== current.jurisdiction) {
        const from = baseline.jurisdiction ?? "(none)";
        const to = current.jurisdiction ?? "(none)";

        changes.push({
            severity: "breaking",
            summary: `Durable Object jurisdiction changed from ${from} to ${to} — this re-homes every DO and strands all existing shard, scheduler, and session-DO data in the old region (no in-place migration; export then import to move it). Revert the change, or override the gate to proceed intentionally.`,
            type: "changedJurisdiction",
        });
    }

    return { changes };
};

/** The decision the pre-deploy gate returns. */
interface SchemaDriftDecision {
    /** True when the deploy must be blocked (breaking drift with no new migration, and no override). */
    blocked: boolean;
    /** Every classified change (both severities), for reporting. */
    changes: ReadonlyArray<DriftChange>;
    /** Migration ids declared now but absent from the baseline — proof a migration was added. */
    newMigrationIds: ReadonlyArray<string>;

    /**
     * A multi-line, actionable explanation. Always present; empty string when
     * there is no drift at all. Mirrors the D1-placeholder guard's message style.
     */
    reason: string;
}

/**
 * Decide whether breaking schema drift should block a deploy.
 *
 * Blocks only when the baseline exists (a first-ever capture is never blocking),
 * there is at least one `breaking` change, no NEW migration id was added since
 * the baseline, and the `allowDrift` override is not set. Safe-only drift (or
 * breaking drift accompanied by a new migration id) passes.
 */
const evaluateSchemaDrift = (options: { allowDrift?: boolean; baseline: SchemaSnapshot | undefined; current: SchemaSnapshot }): SchemaDriftDecision => {
    const { allowDrift = false, baseline, current } = options;
    const drift = diffSchemaSnapshots(baseline, current);
    const breaking = drift.changes.filter((change) => change.severity === "breaking");
    const newMigrationIds = current.migrationIds.filter((id) => !(baseline?.migrationIds ?? []).includes(id));

    // No drift at all, or a first-ever capture (no baseline to compare against) —
    // never block.
    if (drift.changes.length === 0 || baseline === undefined) {
        return { blocked: false, changes: drift.changes, newMigrationIds, reason: "" };
    }

    if (breaking.length === 0) {
        const summary = drift.changes.map((change) => `  - ${change.summary}`).join("\n");

        return { blocked: false, changes: drift.changes, newMigrationIds, reason: `schema drift detected (all additive/safe):\n${summary}` };
    }

    const breakingSummary = breaking.map((change) => `  - ${change.summary}`).join("\n");

    if (newMigrationIds.length > 0) {
        return {
            blocked: false,
            changes: drift.changes,
            newMigrationIds,
            reason: `breaking schema drift detected, but ${String(newMigrationIds.length)} new migration(s) were added (${newMigrationIds.join(", ")}):\n${breakingSummary}`,
        };
    }

    // "Schema drift" means the current schema differs from the last deployed
    // shape — so existing data in production may not match the new type
    // expectations. Breaking drift (removed table/field, changed type) needs a
    // migration that tells Lunora how to transform existing documents; safe drift
    // (added optional field, new index) can proceed without one.
    const reason =
        `deploy blocked: ${String(breaking.length)} breaking schema change(s) detected since the last blessed schema baseline — ` +
        `these changes are incompatible with existing data without a migration:\n${breakingSummary}\n\n` +
        `To fix:\n` +
        `  • For breaking changes: add a \`defineMigration({ id, table, up })\` in lunora/ for each affected table, ` +
        `then run \`lunora migrate\` (or \`lunora codegen\`) to apply and re-bless the baseline.\n` +
        `  • For backward-compatible changes (e.g. adding an optional field): pass \`--allow-schema-drift\` to skip the block.\n` +
        `  • To accept the new shape without a migration (you know data is compatible): pass \`--update-schema-baseline\`.\n` +
        `Docs: https://lunora.dev/docs/migrations`;

    if (allowDrift) {
        return { blocked: false, changes: drift.changes, newMigrationIds, reason: `${reason}\n\n(overridden by --allow-schema-drift)` };
    }

    return { blocked: true, changes: drift.changes, newMigrationIds, reason };
};

export type { DriftChange, FieldSnapshot, IndexSnapshot, RelationSnapshot, SchemaDrift, SchemaDriftDecision, SchemaSnapshot, TableSnapshot };
export {
    buildSchemaSnapshot,
    diffSchemaSnapshots,
    evaluateSchemaDrift,
    parseSchemaSnapshot,
    SCHEMA_SNAPSHOT_VERSION,
    SchemaSnapshotParseError,
    serializeSchemaSnapshot,
};
