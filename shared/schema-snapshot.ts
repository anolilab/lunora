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

import { contentDigest } from "./content-digest";

/** Current snapshot format version. Bumped if the structural shape below changes. */
const SCHEMA_SNAPSHOT_VERSION = 1 as const;

/**
 * A single field's structural shape.
 *
 * `kind` + `optional` were once the whole record, which made every change INSIDE
 * a validator invisible to the diff, to the serialized baseline, and to the
 * content hash — `v.id("users")` → `v.id("orgs")`, `v.array(v.string())` →
 * `v.array(v.bigint())` (which changes the storage projection), a swapped union
 * member, an added `.unique()`. Zero drift, byte-identical snapshot, same hash,
 * so `recordSchemaVersion` did not even append a ledger row.
 *
 * Everything past `optional` is therefore recorded too. All of it is declared
 * OPTIONAL so a baseline written before the deepening still parses (no
 * {@link SCHEMA_SNAPSHOT_VERSION} bump, which `parseSnapshotJson` would turn into
 * a hard reject with no upgrade path) — see {@link recordsFieldDetail} for how the
 * differ tells "this baseline predates the detail" from "this field has none".
 */
interface FieldSnapshot {
    /** `v.object({…})` member shapes, key-sorted. */
    fields?: Record<string, FieldSnapshot>;
    /** `v.record(key, …)` key shape. */
    key?: FieldSnapshot;
    /** The validator kind (`string`, `number`, `id`, `object`, …) after unwrapping `v.optional`. */
    kind: string;
    /** `v.literal(value)` — the literal as source text. */
    literal?: string;
    /** `v.union(…)` members, in canonical (not declaration) order — a union is a set. */
    members?: ReadonlyArray<FieldSnapshot>;
    /** `.nullable()` — the column accepts SQL NULL. Always written by a current snapshot. */
    nullable?: boolean;
    /** `v.array(inner)` element / `v.record(…, value)` value shape. */
    of?: FieldSnapshot;
    /** True when declared `v.optional(...)` — accepts `undefined` / absent on insert. */
    optional: boolean;
    /** `v.id("table")` — the referenced table. */
    ref?: string;
    /**
     * A `.check()`/`.max()`/`.email()`/… predicate is declared on the column. Only
     * its PRESENCE is knowable — the IR cannot represent the closure — so
     * `.max(200)` → `.max(500)` stays invisible; adding the first refinement to a
     * populated column does not.
     */
    refined?: boolean;
    /** `.unique()`. Always written by a current snapshot — see {@link recordsFieldDetail}. */
    unique?: boolean;
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

/**
 * Whether a change is anchored to one table's own shape, or to the schema as a
 * whole.
 *
 * This is the signal a UI needs to decide which tables to mark as changed, and
 * it lives HERE — next to the change union it classifies — rather than as a
 * hand-maintained set of type names in the consumer. A set in the consumer gives
 * zero compile-time pressure: adding a variant to `DriftChange["type"]` would
 * silently render an affected table as untouched, which is exactly the
 * UI-disagrees-with-the-deploy-gate divergence this module exists to prevent.
 */
type DriftScope = "schema" | "table";

/**
 * What actually fixes a change, so a consumer can name the right tool.
 *
 * - `"backfill"` — a `defineMigration` transform rewrites the affected rows.
 *   The ONLY value for which a data migration is the answer.
 * - `"rehome"` — the rows' physical storage moves (a different Durable Object,
 *   or a different region). The per-shard runner only ever replaces a row inside
 *   the shard it was handed, so no transform reaches these; the fix is an
 *   export/import round trip, or a revert.
 * - `"code"` — nothing happens to stored data; a query or a call site has to
 *   change (a dropped index, a dropped relation).
 * - `"none"` — additive, nothing to do.
 *
 * This lives HERE, next to the change union, for the same reason {@link DriftScope}
 * does: a hand-maintained set of type names in the consumer gives zero
 * compile-time pressure, so a new variant would silently default to whatever the
 * set omits. The deploy gate uses this to decide both what a data migration may
 * excuse and which tables it offers to scaffold one for — a wrong default there
 * sends the operator to a tool that cannot work.
 */
type DriftRemediation = "backfill" | "code" | "none" | "rehome";

/** One classified structural change between two snapshots. */
interface DriftChange {
    /** What fixes this change — see {@link DriftRemediation}. `"none"` for every `safe` change. */
    remediation: DriftRemediation;

    /**
     * `"table"` means this table's own DDL moved (fields, indexes, shard mode) —
     * a relation whose foreign key lives on the OTHER table stays `"schema"`, so
     * the "changed" signal keeps meaning "this table's shape moved".
     */
    scope: DriftScope;
    /** `"breaking"` changes need attention before deploy; `"safe"` changes are additive. */
    severity: "breaking" | "safe";
    /** Human-readable, actionable description (used in the gate message). */
    summary: string;
    /** The table this change belongs to. Always set when `scope` is `"table"`. */
    table?: string;
    /** A machine-readable change discriminator. */
    type:
        | "addedFieldConstraint"
        | "addedIndex"
        | "addedOptionalField"
        | "addedRelation"
        | "addedRequiredField"
        | "addedTable"
        | "changedFieldKind"
        | "changedFieldShape"
        | "changedIndex"
        | "changedJurisdiction"
        | "changedShardMode"
        | "fieldOptionalToRequired"
        | "fieldRequiredToOptional"
        | "relaxedFieldConstraint"
        | "removedField"
        | "removedIndex"
        | "removedRelation"
        | "removedTable"
        | "widenedFieldShape";
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
 *
 * A `function` declaration, not a generic arrow: this file is bundler-inlined
 * into `@lunora/studio`, whose packem build runs Babel with the React preset,
 * which parses `<T>(…)` as a JSX element and fails. `tsc`, ESLint, and every
 * test pass either way — only the bundle build catches it.
 */
// eslint-disable-next-line func-style -- see above: a generic arrow is misparsed as JSX by the studio's Babel config
function sortKeys<T>(record: Record<string, T>): Record<string, T> {
    const sorted: Record<string, T> = {};
    const keys = Object.keys(record);

    keys.sort();

    for (const key of keys) {
        sorted[key] = record[key] as T;
    }

    return sorted;
}

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
 * non-cryptographic digest is the right tool. A collision is not merely
 * cosmetic, though: `recordSchemaVersion` treats a known hash as "already
 * recorded" and keeps the OLDER snapshot, so the Studio would render a stale
 * shape as the current version and diff it wrongly against its predecessor. With
 * a ~64-bit digest and a 50-version cap that is negligible — but it is a wrong
 * answer, not a merged row, and anyone widening the retention cap should know it.
 */
const hashSchemaSnapshot = (snapshot: SchemaSnapshot): string => contentDigest(serializeSchemaSnapshot(snapshot));

/** True when `value` is a non-null object (the shape every snapshot sub-record must have). */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Structurally validate one parsed table entry, so a `version:1` file with garbage tables is rejected (not diffed). */
const isValidTableSnapshot = (value: unknown): value is TableSnapshot =>
    isRecord(value) && isRecord(value.fields) && isRecord(value.indexes) && isRecord(value.relations) && typeof value.shardMode === "string";

/**
 * Outcome of parsing snapshot JSON — three states, stated as three rather than
 * encoded in two optional fields, so each caller's policy reads as an exhaustive
 * switch instead of a chain of `!== undefined` guards.
 *
 * `absent` is a legitimate "no baseline yet" (a first capture); `invalid` is
 * content that is present but unusable, which the CLI treats as fatal and the
 * Studio renders as an unreadable ledger row. Same parse, two policies.
 */
type SnapshotParseOutcome =
    { readonly status: "absent" } | { readonly error: string; readonly status: "invalid" } | { readonly snapshot: SchemaSnapshot; readonly status: "ok" };

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
        return { status: "absent" };
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(content);
    } catch (error: unknown) {
        return { error: `baseline is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, status: "invalid" };
    }

    if (!isRecord(parsed) || parsed.version !== SCHEMA_SNAPSHOT_VERSION || !isRecord(parsed.tables)) {
        return {
            error: `baseline is malformed or written by an incompatible version (expected version ${String(SCHEMA_SNAPSHOT_VERSION)})`,
            status: "invalid",
        };
    }

    for (const [name, table] of Object.entries(parsed.tables)) {
        if (!isValidTableSnapshot(table)) {
            return { error: `baseline table "${name}" has an invalid structure`, status: "invalid" };
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
        status: "ok",
    };
};

/** Whether two index snapshots are structurally identical (ordered fields + unique flag). */
const indexesEqual = (a: IndexSnapshot, b: IndexSnapshot): boolean =>
    a.unique === b.unique && a.fields.length === b.fields.length && a.fields.every((field, index) => field === b.fields[index]);

/**
 * Does this field snapshot come from a format that records constraints and
 * nested shape?
 *
 * `unique` is written unconditionally by the snapshot builder, so its ABSENCE
 * means the baseline was written before {@link FieldSnapshot} was deepened — not
 * that the column has no `.unique()`. A dimension the baseline never recorded
 * must not be diffed: every existing app would otherwise see one spurious
 * breaking change per constrained/structured field on its first run after the
 * upgrade, and a gate that blocks a deploy nothing actually changed is a gate
 * whose override gets typed reflexively. One re-blessed baseline later the
 * detail is present and every dimension below is live.
 */
const recordsFieldDetail = (field: FieldSnapshot): boolean => field.unique !== undefined;

/**
 * The VALUE-SHAPE half of a field snapshot, as a canonical string.
 *
 * Excludes the column-level flags (`optional`/`unique`/`nullable`/`refined`),
 * which are diffed on their own — folding them in here would report one edit as
 * two changes. Property order is fixed by this literal, and every nested record
 * is already key-sorted by the builder, so two structurally-identical shapes
 * always produce identical bytes.
 */
const shapeForm = ({ nullable, optional, refined, unique, ...shape }: FieldSnapshot): string => {
    // Destructured, not enumerated. Listing the INTERIOR keys means a dimension
    // added to `FieldSnapshot` and to the snapshot builder but forgotten here is
    // recorded and never compared — a byte-identical diff over a changed shape,
    // which is the exact bug this whole comparison exists to catch, reintroduced
    // one key at a time and invisible to every test. Naming the FLAGS instead
    // fails safe: a new interior key is compared automatically, and a new flag
    // key over-reports until it is added above, which is the harmless direction.
    return JSON.stringify(sortKeys(shape as Record<string, unknown>));
};

/**
 * One accepted form: a value shape plus the VALIDATION state attached to it.
 *
 * `shapeForm` alone is wrong here. It strips `optional`/`nullable`/`refined`
 * because a COLUMN's flags are diffed on their own, but a union MEMBER's are
 * diffed nowhere — the only comparison that ever sees them is this one. Stripped,
 * `v.union(v.string(), v.number())` → `v.union(v.string().check(…), v.number())`
 * read as an unchanged member set and was reported `widenedFieldShape` ("every
 * stored value stays valid") for a change that narrows the accepted strings;
 * dropping `v.optional(…)` from a member did the same. `unique` is left out: it
 * is a storage constraint on the column, not part of the value a member accepts.
 */
const acceptedForm = ({ nullable, optional, refined, unique, ...shape }: FieldSnapshot): string =>
    JSON.stringify([sortKeys(shape as Record<string, unknown>), optional, nullable === true, refined === true]);

/**
 * A field's accepted shapes as a set of canonical forms: a union contributes its
 * members, anything else itself.
 *
 * A non-union field is normalized to a member's neutral flags first. Its
 * `optional`/`nullable`/`refined` belong to the column and are diffed there —
 * unchanged across the pair by the time this runs, or already reported — while
 * the union member it is being matched against carries no column metadata at
 * all. Left in, `v.optional(v.string())` → `v.optional(v.union(v.string(),
 * v.number()))` failed to match its own member and lost a real widening.
 */
const memberForms = (field: FieldSnapshot): string[] =>
    field.kind === "union" && field.members
        ? field.members.map((member) => acceptedForm(member))
        : [acceptedForm({ ...field, nullable: false, optional: false, refined: false })];

/**
 * Is `field` a widening of `old` — does it still accept everything `old` did?
 *
 * `v.string()` → `v.union(v.string(), v.number())` invalidates no stored row, so
 * it is safe; the reverse narrowing, and a union that SWAPS a member, are not.
 * Judged by union membership alone, which is the only widening the schema
 * surface can express — anything subtler falls through to `breaking`, which is
 * the safe direction to be wrong in.
 */
const isWidening = (old: FieldSnapshot, field: FieldSnapshot): boolean => {
    if (field.kind !== "union") {
        return false;
    }

    const accepted = new Set(memberForms(field));

    return memberForms(old).every((form) => accepted.has(form));
};

/**
 * Short rendering of a field's value shape (`id(users)`, `array(bigint)`, `a | b`).
 *
 * Shared with the studio's schema-diff view, not just the drift summaries: a
 * column cell rendered from `kind` alone shows `id` on both sides of a repointed
 * foreign key, so the row reads "changed" while the two cells it is contrasting
 * look identical. Same text on both surfaces, from one function.
 */
const describeShape = (field: FieldSnapshot): string => {
    switch (field.kind) {
        case "array": {
            return `array(${field.of ? describeShape(field.of) : "?"})`;
        }
        case "id": {
            return `id(${field.ref ?? "?"})`;
        }
        case "literal": {
            return `literal(${field.literal ?? "?"})`;
        }
        case "object": {
            return `object({ ${Object.keys(field.fields ?? {}).join(", ")} })`;
        }
        case "record": {
            return `record(${field.key ? describeShape(field.key) : "?"}, ${field.of ? describeShape(field.of) : "?"})`;
        }
        case "union": {
            return (field.members ?? []).map((member) => describeShape(member)).join(" | ");
        }
        default: {
            return field.kind;
        }
    }
};

/** A breaking change to one field that a `defineMigration` transform can repair. */
const breakingFieldChange = (tableName: string, type: DriftChange["type"], summary: string): DriftChange => {
    return { remediation: "backfill", scope: "table", severity: "breaking", summary, table: tableName, type };
};

/** An additive/relaxing change to one field — nothing stored becomes invalid. */
const safeFieldChange = (tableName: string, type: DriftChange["type"], summary: string): DriftChange => {
    return { remediation: "none", scope: "table", severity: "safe", summary, table: tableName, type };
};

/**
 * Classify a change to the field's value SHAPE: its kind, its `v.id` target, its
 * element/member/property shapes, its literal value.
 *
 * A widening is safe; a kind change keeps its own (long-standing) discriminator;
 * everything else is a same-kind structural change — a repointed foreign key, a
 * changed array element type (which moves the storage projection), a swapped
 * union member, a different literal.
 */
const diffFieldShape = (tableName: string, name: string, old: FieldSnapshot, field: FieldSnapshot, deep: boolean): DriftChange | undefined => {
    if (old.kind === field.kind && (!deep || shapeForm(old) === shapeForm(field))) {
        return undefined;
    }

    if (deep && isWidening(old, field)) {
        return safeFieldChange(
            tableName,
            "widenedFieldShape",
            `field ${tableName}.${name} widened: ${describeShape(old)} → ${describeShape(field)} — every stored value stays valid`,
        );
    }

    if (old.kind !== field.kind) {
        return breakingFieldChange(
            tableName,
            "changedFieldKind",
            `field ${tableName}.${name} changed type: ${old.kind} → ${field.kind} — add a data migration to convert existing values`,
        );
    }

    return breakingFieldChange(
        tableName,
        "changedFieldShape",
        `field ${tableName}.${name} changed shape: ${describeShape(old)} → ${describeShape(field)} — stored values were written against the old shape; add a data migration to convert them`,
    );
};

/**
 * Classify the column-level constraints: `.unique()`, `.nullable()`, and whether
 * a `.check()`-family refinement is declared.
 *
 * Tightening any of the three can invalidate rows already on disk (duplicates,
 * NULLs, values the new predicate rejects) and none of them is verifiable from
 * the schema, so each is breaking with a backfill as the fix. Relaxing one
 * cannot invalidate anything, so it is safe.
 */
const diffFieldConstraints = (tableName: string, name: string, old: FieldSnapshot, field: FieldSnapshot): DriftChange[] => {
    const changes: DriftChange[] = [];

    if (old.unique !== field.unique) {
        changes.push(
            field.unique === true
                ? breakingFieldChange(
                      tableName,
                      "addedFieldConstraint",
                      `field ${tableName}.${name} became unique — existing duplicates would violate it; add a data migration to de-duplicate first`,
                  )
                : safeFieldChange(tableName, "relaxedFieldConstraint", `field ${tableName}.${name} is no longer unique`),
        );
    }

    if (old.nullable !== field.nullable) {
        changes.push(
            field.nullable === true
                ? safeFieldChange(tableName, "relaxedFieldConstraint", `field ${tableName}.${name} became nullable`)
                : breakingFieldChange(
                      tableName,
                      "addedFieldConstraint",
                      `field ${tableName}.${name} is no longer nullable — rows holding NULL would be invalid; add a data migration to backfill them`,
                  ),
        );
    }

    if (old.refined !== field.refined) {
        changes.push(
            field.refined === true
                ? breakingFieldChange(
                      tableName,
                      "addedFieldConstraint",
                      `field ${tableName}.${name} gained a validation refinement — stored values were never checked against it; add a data migration if any could fail`,
                  )
                : safeFieldChange(tableName, "relaxedFieldConstraint", `field ${tableName}.${name} dropped its validation refinement`),
        );
    }

    return changes;
};

/**
 * Classify the change to a single field that exists in BOTH snapshots (shape,
 * constraints, optionality flip).
 *
 * Exported for the studio's schema-diff view, which needs a per-field verdict
 * and must reach it through THIS function rather than a comparison of its own —
 * a second opinion is how the canvas comes to render as unchanged exactly what
 * the deploy gate blocks. `tableName`/`name` only reach the operator-facing
 * summary text, so a caller that wants the verdict alone can pass anything.
 */
const diffExistingField = (tableName: string, name: string, old: FieldSnapshot, field: FieldSnapshot): DriftChange[] => {
    const changes: DriftChange[] = [];
    // Both sides must record the detail for a comparison over it to mean
    // anything — see `recordsFieldDetail`.
    const deep = recordsFieldDetail(old) && recordsFieldDetail(field);
    const shapeChange = diffFieldShape(tableName, name, old, field, deep);

    if (shapeChange) {
        changes.push(shapeChange);
    }

    if (deep) {
        changes.push(...diffFieldConstraints(tableName, name, old, field));
    }

    if (old.optional && !field.optional) {
        changes.push({
            remediation: "backfill",
            severity: "breaking",
            summary: `field ${tableName}.${name} became required — rows missing it would be invalid; add a data migration to backfill it`,
            table: tableName,
            scope: "table",
            type: "fieldOptionalToRequired",
        });
    } else if (!old.optional && field.optional) {
        changes.push({
            remediation: "none",
            scope: "table",
            severity: "safe",
            summary: `field ${tableName}.${name} became optional`,
            table: tableName,
            type: "fieldRequiredToOptional",
        });
    }

    return changes;
};

/** Classify a field present only in the CURRENT snapshot: optional ⇒ safe, required ⇒ needs a backfill. */
const addedFieldChange = (tableName: string, name: string, field: FieldSnapshot): DriftChange =>
    field.optional
        ? {
              remediation: "none",
              scope: "table",
              severity: "safe",
              summary: `added optional field ${tableName}.${name}`,
              table: tableName,
              type: "addedOptionalField",
          }
        : {
              remediation: "backfill",
              severity: "breaking",
              summary: `added required field ${tableName}.${name} — existing rows have no value; add a data migration to backfill it`,
              table: tableName,
              scope: "table",
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
                remediation: "backfill",
                severity: "breaking",
                summary: `removed field ${tableName}.${name} — add a data migration if stored data must be cleaned up`,
                table: tableName,
                scope: "table",
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
            changes.push({
                remediation: "none",
                scope: "table",
                severity: "safe",
                summary: `added index ${name} on ${tableName}`,
                table: tableName,
                type: "addedIndex",
            });

            continue;
        }

        if (!indexesEqual(old, index)) {
            changes.push({
                remediation: "code",
                severity: "breaking",
                summary: `index ${name} on ${tableName} changed shape — a query may have relied on the old index`,
                table: tableName,
                scope: "table",
                type: "changedIndex",
            });
        }
    }

    for (const name of Object.keys(baseline.indexes)) {
        if (current.indexes[name] === undefined) {
            changes.push({
                remediation: "code",
                severity: "breaking",
                summary: `removed index ${name} on ${tableName} — a query that used \`.withIndex("${name}")\` would break`,
                table: tableName,
                scope: "table",
                type: "removedIndex",
            });
        }
    }
};

/** Diff the relations of one table that exists in both snapshots. */
const diffRelations = (tableName: string, baseline: TableSnapshot, current: TableSnapshot, changes: DriftChange[]): void => {
    for (const name of Object.keys(current.relations)) {
        if (baseline.relations[name] === undefined) {
            changes.push({
                remediation: "none",
                scope: "schema",
                severity: "safe",
                summary: `added relation ${tableName}.${name}`,
                table: tableName,
                type: "addedRelation",
            });
        }
    }

    for (const name of Object.keys(baseline.relations)) {
        if (current.relations[name] === undefined) {
            changes.push({
                remediation: "code",
                scope: "schema",
                severity: "breaking",
                summary: `removed relation ${tableName}.${name}`,
                table: tableName,
                type: "removedRelation",
            });
        }
    }
};

/** Diff one table that exists in both snapshots (shard mode, fields, indexes, relations). */
const diffExistingTable = (tableName: string, baseline: TableSnapshot, current: TableSnapshot, changes: DriftChange[]): void => {
    if (baseline.shardMode !== current.shardMode) {
        changes.push({
            // `breaking` is load-bearing beyond this gate: because it blocks the
            // deploy, rows cannot be stranded in `__root__` without someone
            // passing `--allow-schema-drift` deliberately. The studio leans on
            // that to justify NOT shipping a stranded-rows detector — see
            // TODO(stranded-rows) in
            // `packages/studio/src/features/advisors/derive-insights.ts`. Soften
            // this severity and that detector becomes owed.
            // Deliberately NOT `"backfill"`: `defineMigration` runs inside one
            // shard and can only `replace` the row it was handed, so it cannot
            // move a row between shards. Naming it here sends the operator to the
            // one tool guaranteed not to work, at the exact moment the gate has
            // their attention.
            remediation: "rehome",
            severity: "breaking",
            summary: `table ${tableName} changed shard mode: ${baseline.shardMode} → ${current.shardMode} — its physical storage moves, and existing rows do NOT follow the schema; re-home them with an export/import round trip (https://lunora.sh/docs/concepts/sharding#migrating-a-populated-table)`,
            table: tableName,
            scope: "table",
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
            changes.push({ remediation: "none", scope: "table", severity: "safe", summary: `added table ${tableName}`, table: tableName, type: "addedTable" });

            continue;
        }

        diffExistingTable(tableName, old, table, changes);
    }

    for (const tableName of Object.keys(baselineTables)) {
        if (current.tables[tableName] === undefined) {
            changes.push({
                // NOT `"backfill"`, though this summary used to name one: a
                // transform returns a document that replaces the SAME row in the
                // SAME table, and its reader is read-only, so it can neither
                // delete the rows nor copy them anywhere. The table is also gone
                // from the schema by now, so the migration's target would not
                // resolve. Export the shard if the data is wanted.
                remediation: "rehome",
                scope: "table",
                severity: "breaking",
                summary: `removed table ${tableName} — its rows stay in each shard's SQLite, unreachable through the schema; export the shard first if the data must be kept`,
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
            remediation: "rehome",
            scope: "schema",
            severity: "breaking",
            summary: `Durable Object jurisdiction changed from ${from} to ${to} — this re-homes every DO and strands all existing shard, scheduler, and session-DO data in the old region (no in-place migration; export then import to move it). Revert the change, or override the gate to proceed intentionally.`,
            type: "changedJurisdiction",
        });
    }

    return { changes };
};

export {
    describeShape,
    diffExistingField,
    diffSchemaSnapshots,
    hashSchemaSnapshot,
    isValidTableSnapshot,
    parseSnapshotJson,
    SCHEMA_SNAPSHOT_VERSION,
    serializeSchemaSnapshot,
    sortKeys,
};
export type {
    DriftChange,
    DriftRemediation,
    DriftScope,
    FieldSnapshot,
    IndexSnapshot,
    RelationSnapshot,
    SchemaDrift,
    SchemaSnapshot,
    SnapshotParseOutcome,
    TableSnapshot,
};
