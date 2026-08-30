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
 * `prepare`) blocks a deploy when a breaking change is not COVERED by a new
 * migration — one declared since the baseline that iterates that very table —
 * and names the `lunora migrate create` command for each table still owed one.
 * The footgun this closes is shipping a schema change that needs a backfill with
 * no migration to perform it.
 *
 * Everything here is pure (no I/O) so it is unit-testable; the CLI owns reading
 * and writing the baseline file.
 */
import { LunoraError } from "@lunora/errors";

import type { DriftChange, FieldSnapshot, IndexSnapshot, RelationSnapshot, SchemaSnapshot, TableSnapshot } from "../../../shared/schema-snapshot";
import { diffSchemaSnapshots, parseSnapshotJson, SCHEMA_SNAPSHOT_VERSION, sortKeys } from "../../../shared/schema-snapshot";
import type { SchemaIR, TableIR, ValidatorIR } from "./ir";

/**
 * Encode a `TableIR.shardMode` into the snapshot's stable string form.
 */
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
 * Build a {@link SchemaSnapshot} from a parsed {@link SchemaIR} and the set of
 * declared migration ids. Tables and migration ids are sorted so the emitted
 * JSON is byte-stable across runs AND across machines (no spurious diffs /
 * churn) — see `sortKeys` in `shared/schema-snapshot.ts` for why that ordering
 * must not be locale-aware.
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

/**
 * Parse a committed snapshot file. Returns `undefined` ONLY when the content is
 * absent/empty; throws {@link SchemaSnapshotParseError} when content is present
 * but malformed (bad JSON, wrong version, or structurally-invalid tables) so the
 * caller can distinguish "no baseline yet" (a legitimate first capture) from "a
 * corrupt baseline" (which must not be silently treated as a first capture).
 *
 * The parsing itself lives in `shared/schema-snapshot.ts` (the Studio reads the
 * same JSON out of the DO ledger); this wrapper only applies the CLI's policy of
 * treating a malformed baseline as fatal.
 */
const parseSchemaSnapshot = (content: string | undefined): SchemaSnapshot | undefined => {
    const outcome = parseSnapshotJson(content);

    if (outcome.status === "invalid") {
        throw new SchemaSnapshotParseError(outcome.error);
    }

    return outcome.status === "ok" ? outcome.snapshot : undefined;
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

/** The commands that can print the blocked-drift remediation, and which override flags each accepts. */
const DRIFT_FLAG_SUPPORT: Record<string, { allowDrift: boolean; updateBaseline: boolean }> = {
    deploy: { allowDrift: true, updateBaseline: true },
    prepare: { allowDrift: true, updateBaseline: true },
    verify: { allowDrift: true, updateBaseline: false },
};

/**
 * Render only the override flags the command that is printing this actually
 * accepts, and name the alternative when it accepts none.
 *
 * The message used to list both flags unconditionally, so following it verbatim
 * failed: `build` accepts neither (`Found unknown option "--allow-schema-drift"`)
 * and `verify` accepts only the first. This is the message a first-time deployer
 * hits, and half its own advice did not work on the command that printed it.
 *
 * Only the three commands that actually run the gate are listed
 * (`prepare` / `deploy` / `verify`); `build` and `codegen` never reach it, so an
 * entry for them would describe a message no user can see. An unrecognised
 * caller falls back to listing both flags — better an over-broad hint than none.
 */
const ALLOW_DRIFT_LINE = "  • For backward-compatible changes (e.g. adding an optional field): pass `--allow-schema-drift` to skip the block.";
const UPDATE_BASELINE_LINE = "  • To accept the new shape without a migration (you know data is compatible): pass `--update-schema-baseline`.";

const remediationFlagLines = (command: string | undefined): string => {
    const support = command === undefined ? undefined : DRIFT_FLAG_SUPPORT[command];

    if (command === undefined || support === undefined) {
        return `${ALLOW_DRIFT_LINE}\n${UPDATE_BASELINE_LINE}\n`;
    }

    // Every command that runs the gate accepts `--allow-schema-drift`, so that
    // line is unconditional; only the baseline re-bless varies. (`verify` runs
    // the gate read-only, so re-blessing from it would be wrong, not missing.)
    const baselineLine = support.updateBaseline
        ? UPDATE_BASELINE_LINE
        : `  • To accept the new shape without a migration, run \`lunora prepare --update-schema-baseline\` — \`lunora ${command}\` does not take that flag.`;

    return `${ALLOW_DRIFT_LINE}\n${baselineLine}\n`;
};

/**
 * Breaking changes a `defineMigration` provably CANNOT remediate, so a new
 * migration must never excuse one.
 *
 * Both re-home physical storage: a shard-mode flip moves a table's rows to a
 * different Durable Object, and a jurisdiction change moves every DO to another
 * region. The per-shard runner only ever `replace`s a row inside the shard it
 * was handed, so neither is reachable from a transform — the fix is an
 * export/import round trip or a revert, which is what both summaries already
 * say. Excusing them would send the operator to the one tool guaranteed not to
 * work, at the exact moment the gate has their attention.
 */
const UNMIGRATABLE_BREAKING_TYPES: ReadonlySet<DriftChange["type"]> = new Set(["changedJurisdiction", "changedShardMode"]);

/** The scaffold command for a table's missing backfill, ready to paste. */
const scaffoldLine = (table: string): string => `      lunora migrate create backfill_${table.replaceAll(/\W/gu, "_")} --table ${table}`;

/**
 * Decide whether breaking schema drift should block a deploy.
 *
 * Blocks only when the baseline exists (a first-ever capture is never blocking),
 * there is at least one `breaking` change, no new migration COVERS it, and the
 * `allowDrift` override is not set. Safe-only drift passes.
 *
 * "Covers" is per-table, not per-run: a new migration excuses breaking drift on
 * the table it iterates, and nothing else. Counting new ids alone let a backfill
 * on `messages` unblock a required field added to `users` — the gate reported
 * "accompanied by a migration" for a change that migration would never visit.
 * The shard-mode diff leans on this gate to justify the studio not shipping a
 * stranded-rows detector, and that claim only holds if an unrelated migration
 * cannot wave it through.
 *
 * `migrations` carries this run's declared ids and the table each iterates. It
 * is optional so a caller without the IR keeps working, but the CLI gate always
 * passes it — and without it nothing is covered, so the block is strictly
 * tighter, never looser.
 */
const evaluateSchemaDrift = (options: {
    allowDrift?: boolean;
    baseline: SchemaSnapshot | undefined;
    /** The command printing the remediation, so it names only flags that command accepts. */
    command?: string;
    current: SchemaSnapshot;
    /** This run's declared migrations, so a new one is matched to the table it iterates. */
    migrations?: ReadonlyArray<{ id: string; table: string }>;
}): SchemaDriftDecision => {
    const { allowDrift = false, baseline, command, current, migrations = [] } = options;
    const drift = diffSchemaSnapshots(baseline, current);
    const breaking = drift.changes.filter((change) => change.severity === "breaking");
    const newMigrationIds = current.migrationIds.filter((id) => !(baseline?.migrationIds ?? []).includes(id));
    const decide = (blocked: boolean, reason: string): SchemaDriftDecision => {
        return { blocked, changes: drift.changes, newMigrationIds, reason };
    };

    // Tables a NEW migration iterates. A migration whose `table` is `""` — not a
    // static string literal, so codegen could not lift it — covers nothing
    // rather than everything: failing closed keeps an unresolvable declaration
    // from becoming a blanket override.
    const coveredTables = new Set(
        migrations.filter((migration) => newMigrationIds.includes(migration.id) && migration.table !== "").map((migration) => migration.table),
    );
    const isCovered = (change: DriftChange): boolean =>
        !UNMIGRATABLE_BREAKING_TYPES.has(change.type) && change.table !== undefined && coveredTables.has(change.table);

    // No drift at all, or a first-ever capture (no baseline to compare against) —
    // never block.
    if (drift.changes.length === 0 || baseline === undefined) {
        return decide(false, "");
    }

    if (breaking.length === 0) {
        const summary = drift.changes.map((change) => `  - ${change.summary}`).join("\n");

        return decide(false, `schema drift detected (all additive/safe):\n${summary}`);
    }

    const breakingSummary = breaking.map((change) => `  - ${change.summary}`).join("\n");
    const uncovered = breaking.filter((change) => !isCovered(change));

    if (uncovered.length === 0) {
        return decide(
            false,
            `breaking schema drift detected, covered by ${String(newMigrationIds.length)} new migration(s) (${newMigrationIds.join(", ")}):\n${breakingSummary}`,
        );
    }

    // The tables still owed a backfill, in first-seen order so the scaffold lines
    // mirror the summaries above them. `changedShardMode` names a table but can
    // never be covered, so it is excluded — printing `migrate create` for it
    // would contradict its own summary, which sends you to export/import.
    const owedTables = [
        ...new Set(
            uncovered.filter((change) => change.table !== undefined && !UNMIGRATABLE_BREAKING_TYPES.has(change.type)).map((change) => change.table as string),
        ),
    ];
    const uncoveredSummary = uncovered.map((change) => `  - ${change.summary}`).join("\n");
    const scaffold = owedTables.length === 0 ? "" : `\n\n    Scaffold the missing migration(s):\n${owedTables.map((table) => scaffoldLine(table)).join("\n")}`;

    // "Schema drift" means the current schema differs from the last deployed
    // shape — so existing data in production may not match the new type
    // expectations. Breaking drift (removed table/field, changed type) needs a
    // migration that tells Lunora how to transform existing documents; safe drift
    // (added optional field, new index) can proceed without one.
    const reason =
        `deploy blocked: ${String(uncovered.length)} breaking schema change(s) since the last blessed schema baseline are not covered by a new migration — ` +
        `these changes are incompatible with existing data:\n${uncoveredSummary}\n\n` +
        `To fix:\n` +
        `  • For breaking changes: add a \`defineMigration({ id, table, up })\` in lunora/ for each affected table, ` +
        `then run \`lunora migrate\` (or \`lunora codegen\`) to apply and re-bless the baseline.${scaffold}\n` +
        `${remediationFlagLines(command)}Docs: https://lunora.dev/docs/migrations`;

    if (allowDrift) {
        return decide(false, `${reason}\n\n(overridden by --allow-schema-drift)`);
    }

    return decide(true, reason);
};

// The snapshot format, its diff, and the serializer moved to
// `shared/schema-snapshot.ts` so `@lunora/studio` can render the SAME diff the
// deploy gate blocks on. Re-exported here so every existing import site
// (`run-codegen.ts`, the CLI gate, the tests) is unchanged.
export type { DriftChange, FieldSnapshot, IndexSnapshot, RelationSnapshot, SchemaDrift, SchemaSnapshot, TableSnapshot } from "../../../shared/schema-snapshot";
export { diffSchemaSnapshots, SCHEMA_SNAPSHOT_VERSION, serializeSchemaSnapshot } from "../../../shared/schema-snapshot";
export type { SchemaDriftDecision };
export { buildSchemaSnapshot, evaluateSchemaDrift, parseSchemaSnapshot, SchemaSnapshotParseError };
