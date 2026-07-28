/**
 * The structural schema-snapshot format and its diff, shared by `@lunora/codegen`
 * (which builds snapshots from the parsed schema IR and gates deploys on the
 * diff) and `@lunora/studio` (which renders the same diff as a visual migration
 * history).
 *
 * Having ONE diff is the point: the Studio's schema-history view and the
 * pre-deploy drift gate must classify a change identically, or the UI will say a
 * change is safe while `lunora deploy` refuses it. `@lunora/codegen` is a
 * build-time package the browser bundle cannot import, and neither package sits
 * below the other, so — like `shared/quote-identifier.ts` — this lives outside
 * both and is bundler-inlined into each. Keep it genuinely zero-dependency
 * (relative/built-in imports only) or inlining breaks. Consumers must drop
 * `outDir`/`rootDir` from their `tsconfig.json` (a set `rootDir` raises TS6059
 * for this out-of-package file under `tsc --noEmit`).
 *
 * What stays in `@lunora/codegen`: building a snapshot from `SchemaIR`, the
 * `SchemaSnapshotParseError` class (it extends `LunoraError`), and the deploy
 * gate's policy (`evaluateSchemaDrift`). What lives here: the format, the diff,
 * the severity classification, and the content hash.
 */

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
     * `"shardBy:<field>"` (partitioned). Encoded as a string so the snapshot
     * stays a plain JSON-stable value.
     */
    shardMode: string;
}

/** A deterministic structural view of the whole schema at one point in time. */
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

/** One classified structural change between two snapshots. */
interface DriftChange {
    /** `"breaking"` changes need a data migration; `"safe"` changes are additive. */
    severity: "breaking" | "safe";
    /** Human-readable, actionable description (used in the gate message). */
    summary: string;
    /** The table this change belongs to, so a UI can group changes per table. */
    table?: string;
    /** A machine-readable change discriminator. */
    type:
        | "addedIndex"
        | "addedOptionalField"
        | "addedRelation"
        | "addedRequiredField"
        | "addedTable"
        | "changedFieldKind"
        | "changedIndex"
        | "changedJurisdiction"
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

    keys.sort();

    for (const key of keys) {
        sorted[key] = record[key] as T;
    }

    return sorted;
};

/** Serialize a snapshot to the exact bytes written to `lunora/.lunora-schema.json` (trailing newline). */
const serializeSchemaSnapshot = (snapshot: SchemaSnapshot): string => `${JSON.stringify(snapshot, undefined, 2)}\n`;

/**
 * Stable 16-character content hash of a snapshot — the schema version's identity
 * in the DO's `__lunora_schema_history` ledger.
 *
 * FNV-1a over the canonical serialization, run twice with different offsets and
 * concatenated to widen the digest. Deliberately NOT `node:crypto` or
 * `crypto.subtle`: this must run synchronously inside `runShardMigrations` on a
 * DO cold start, where `subtle.digest` is async and `node:crypto` is absent.
 * Content addressing here is for identity and dedup, not for security, so a
 * non-cryptographic digest is the right tool — a collision costs one merged
 * timeline entry, not a trust boundary.
 */
const hashSchemaSnapshot = (snapshot: SchemaSnapshot): string => {
    const text = serializeSchemaSnapshot(snapshot);

    const fnv = (offset: number): string => {
        let hash = offset;

        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.codePointAt(index) ?? 0;
            // FNV prime 16777619, applied with shifts to stay inside 32-bit int math.
            hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
        }

        return hash.toString(16).padStart(8, "0");
    };

    return `${fnv(0x81_1c_9d_c5)}${fnv(0x01_00_01_93)}`;
};

/** True when `value` is a non-null object (the shape every snapshot sub-record must have). */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Structurally validate one parsed table entry, so a `version:1` file with garbage tables is rejected (not diffed). */
const isValidTableSnapshot = (value: unknown): value is TableSnapshot =>
    isRecord(value) && isRecord(value.fields) && isRecord(value.indexes) && isRecord(value.relations) && typeof value.shardMode === "string";

/** Outcome of parsing snapshot JSON: the snapshot, an explanation of why it is unusable, or neither (absent). */
interface SnapshotParseOutcome {
    /** Set when content was present but malformed. The caller decides whether that is fatal. */
    error?: string;
    /** Set when content parsed into a structurally valid snapshot. */
    snapshot?: SchemaSnapshot;
}

/**
 * Parse snapshot JSON without deciding what a failure means.
 *
 * Returns an empty outcome for absent/empty content (a legitimate "no baseline
 * yet"), `{ error }` for content that is present but malformed, and
 * `{ snapshot }` otherwise. The CLI gate turns `error` into a thrown
 * `SchemaSnapshotParseError` because a corrupt committed baseline must not be
 * silently treated as a first capture; the Studio renders it as an unreadable
 * ledger row and moves on. Same parse, two policies.
 */
const parseSnapshotJson = (content: string | undefined): SnapshotParseOutcome => {
    if (content === undefined || content.trim() === "") {
        return {};
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(content);
    } catch (error: unknown) {
        return { error: `baseline is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }

    if (!isRecord(parsed) || parsed.version !== SCHEMA_SNAPSHOT_VERSION || !isRecord(parsed.tables)) {
        return { error: `baseline is malformed or written by an incompatible version (expected version ${String(SCHEMA_SNAPSHOT_VERSION)})` };
    }

    for (const [name, table] of Object.entries(parsed.tables)) {
        if (!isValidTableSnapshot(table)) {
            return { error: `baseline table "${name}" has an invalid structure` };
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
        snapshot: {
            jurisdiction,
            migrationIds: Array.isArray(parsed.migrationIds) ? (parsed.migrationIds as ReadonlyArray<string>) : [],
            tables: parsed.tables as Record<string, TableSnapshot>,
            version: SCHEMA_SNAPSHOT_VERSION,
        },
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
            table: tableName,
            type: "changedFieldKind",
        });
    }

    if (old.optional && !field.optional) {
        changes.push({
            severity: "breaking",
            summary: `field ${tableName}.${name} became required — rows missing it would be invalid; add a data migration to backfill it`,
            table: tableName,
            type: "fieldOptionalToRequired",
        });
    } else if (!old.optional && field.optional) {
        changes.push({ severity: "safe", summary: `field ${tableName}.${name} became optional`, table: tableName, type: "fieldRequiredToOptional" });
    }

    return changes;
};

/** Classify a field present only in the CURRENT snapshot: optional ⇒ safe, required ⇒ needs a backfill. */
const addedFieldChange = (tableName: string, name: string, field: FieldSnapshot): DriftChange =>
    field.optional
        ? { severity: "safe", summary: `added optional field ${tableName}.${name}`, table: tableName, type: "addedOptionalField" }
        : {
              severity: "breaking",
              summary: `added required field ${tableName}.${name} — existing rows have no value; add a data migration to backfill it`,
              table: tableName,
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
                table: tableName,
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
            changes.push({ severity: "safe", summary: `added index ${name} on ${tableName}`, table: tableName, type: "addedIndex" });

            continue;
        }

        if (!indexesEqual(old, index)) {
            changes.push({
                severity: "breaking",
                summary: `index ${name} on ${tableName} changed shape — a query may have relied on the old index`,
                table: tableName,
                type: "changedIndex",
            });
        }
    }

    for (const name of Object.keys(baseline.indexes)) {
        if (current.indexes[name] === undefined) {
            changes.push({
                severity: "breaking",
                summary: `removed index ${name} on ${tableName} — a query that used \`.withIndex("${name}")\` would break`,
                table: tableName,
                type: "removedIndex",
            });
        }
    }
};

/** Diff the relations of one table that exists in both snapshots. */
const diffRelations = (tableName: string, baseline: TableSnapshot, current: TableSnapshot, changes: DriftChange[]): void => {
    for (const name of Object.keys(current.relations)) {
        if (baseline.relations[name] === undefined) {
            changes.push({ severity: "safe", summary: `added relation ${tableName}.${name}`, table: tableName, type: "addedRelation" });
        }
    }

    for (const name of Object.keys(baseline.relations)) {
        if (current.relations[name] === undefined) {
            changes.push({ severity: "breaking", summary: `removed relation ${tableName}.${name}`, table: tableName, type: "removedRelation" });
        }
    }
};

/** Diff one table that exists in both snapshots (shard mode, fields, indexes, relations). */
const diffExistingTable = (tableName: string, baseline: TableSnapshot, current: TableSnapshot, changes: DriftChange[]): void => {
    if (baseline.shardMode !== current.shardMode) {
        changes.push({
            severity: "breaking",
            summary: `table ${tableName} changed shard mode: ${baseline.shardMode} → ${current.shardMode} — its physical storage moves; add a data migration / re-shard plan`,
            table: tableName,
            type: "changedShardMode",
        });
    }

    diffFields(tableName, baseline, current, changes);
    diffIndexes(tableName, baseline, current, changes);
    diffRelations(tableName, baseline, current, changes);
};

/**
 * Diff the current snapshot against a baseline and classify every structural
 * change. Pure — no I/O. When `baseline` is `undefined` (no snapshot yet) there
 * is no drift to report: every table is treated as a fresh additive
 * `addedTable`, so a first deploy is never blocked.
 */
const diffSchemaSnapshots = (baseline: SchemaSnapshot | undefined, current: SchemaSnapshot): SchemaDrift => {
    const changes: DriftChange[] = [];
    const baselineTables = baseline?.tables ?? {};

    for (const [tableName, table] of Object.entries(current.tables)) {
        const old = baselineTables[tableName];

        if (old === undefined) {
            changes.push({ severity: "safe", summary: `added table ${tableName}`, table: tableName, type: "addedTable" });

            continue;
        }

        diffExistingTable(tableName, old, table, changes);
    }

    for (const tableName of Object.keys(baselineTables)) {
        if (current.tables[tableName] === undefined) {
            changes.push({
                severity: "breaking",
                summary: `removed table ${tableName} — add a data migration if its data must be archived/cleaned up`,
                table: tableName,
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

export { diffSchemaSnapshots, hashSchemaSnapshot, isValidTableSnapshot, parseSnapshotJson, SCHEMA_SNAPSHOT_VERSION, serializeSchemaSnapshot, sortKeys };
export type { DriftChange, FieldSnapshot, IndexSnapshot, RelationSnapshot, SchemaDrift, SchemaSnapshot, SnapshotParseOutcome, TableSnapshot };
