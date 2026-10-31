/**
 * Schema-drift detection for the pre-deploy gate.
 *
 * Lunora's `defineSchema` (tables/indexes/relations) is applied to each DO's
 * SQLite at runtime, and `defineMigration` declarations are hand-written DATA
 * migrations — there is no schema→migration-file mapping to diff the way a
 * Drizzle/Prisma stack would. So instead of regenerating migration DDL, this
 * module captures a deterministic STRUCTURAL snapshot of the schema (per table:
 * each field's full validator shape — kind, optionality, `v.id` target, element /
 * property / member shapes, literal value, `.unique()` / `.nullable()` /
 * refinement — plus indexes, relations, shard mode) and the set of declared
 * migration ids, and diffs the current schema against a COMMITTED baseline
 * (`lunora/.lunora-schema.json`).
 *
 * Each change is classified `safe` (additive — new table, new optional field,
 * added index/relation, a required field made optional) or `breaking` (needs a
 * data migration — dropped table/field, field-kind change, optional→required,
 * a new REQUIRED field on an existing table, a changed shard mode, a
 * removed/renamed index or relation). Each change also carries what actually
 * fixes it (`DriftRemediation`), so the gate can offer a data migration only
 * where one would work.
 *
 * The CLI gate (`lunora deploy`/`verify`/`prepare`) blocks a deploy when a
 * breaking change is not COVERED by a new migration — one declared since the
 * baseline that iterates that very table — and names the `lunora migrate create`
 * command for each table still owed one. The footgun this closes is shipping a
 * schema change that needs a backfill with no migration to perform it.
 *
 * Everything here is pure (no I/O) so it is unit-testable; the CLI owns reading
 * and writing the baseline file.
 */
import { LunoraError } from "@lunora/errors";

import type { DriftChange, FieldSnapshot, IndexSnapshot, RelationSnapshot, SchemaSnapshot, TableSnapshot } from "../../../shared/schema-snapshot";
import { diffSchemaSnapshots, parseSnapshotJson, SCHEMA_SNAPSHOT_VERSION, sortKeys } from "../../../shared/schema-snapshot";
import { isHyperdriveGlobalTable } from "./global-backend";
import type { MigrationIR, QueryReadIR, SchemaIR, TableIR, ValidatorIR } from "./ir";

/**
 * Encode a table's shard mode into the snapshot's stable string form.
 *
 * Takes the whole table, not just `shardMode`, because a `.global()` table's
 * BACKEND is part of the mode: `global-backend.ts` routes `.global()` to D1 and
 * `.global({ backend: "hyperdrive" })` to a Postgres/MySQL database, which is a
 * different physical store that no rows follow. Encoding both as bare `"global"`
 * made switching between them read as no change at all.
 *
 * Read through `isHyperdriveGlobalTable` rather than comparing `globalBackend`
 * here: the field is optional and only that predicate encodes the right
 * comparison for hand-built IR (see `global-backend.ts`).
 */
const encodeShardMode = (table: TableIR): string => {
    const mode = table.shardMode;

    if (mode === "global") {
        return `global:${isHyperdriveGlobalTable(table) ? "hyperdrive" : "d1"}`;
    }

    if (mode === "root") {
        return mode;
    }

    return `shardBy:${mode.field}`;
};

/**
 * Canonical order for `v.union(...)` members. A union is a SET, so
 * `v.union(a, b)` and `v.union(b, a)` describe the same column and must produce
 * the same bytes — otherwise reordering the arguments reports drift, changes the
 * content hash, and burns a `SCHEMA_HISTORY_MAX_VERSIONS` slot for an edit that
 * changed nothing. Compared by code unit for the same reason `sortKeys` is.
 */
const byCanonicalForm = (a: FieldSnapshot, b: FieldSnapshot): number => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);

    if (left === right) {
        return 0;
    }

    return left < right ? -1 : 1;
};

/**
 * Capture one column's full structural shape: its kind and optionality, plus
 * whatever the validator carries INSIDE — the `v.id` target, the array element,
 * the object properties, the record key/value, the literal, the union members —
 * and its column-level constraints.
 *
 * Recursive on purpose. A snapshot of only `{ kind, optional }` is byte-identical
 * across `v.id("users")` → `v.id("orgs")` and `v.array(v.string())` →
 * `v.array(v.bigint())`, so the gate saw no drift, the baseline saw no diff, and
 * the content hash did not move.
 *
 * Determinism: object properties are `sortKeys`-ordered and union members are
 * ordered canonically, so nothing here depends on the order the user happened to
 * declare things in.
 *
 * `.unique()` / `.nullable()` attach to whichever node the chain was applied to —
 * `v.optional(v.string().unique())` records them on the inner validator,
 * `v.optional(v.string()).unique()` on the wrapper — so both nodes are read.
 */
const fieldSnapshotOf = (validator: ValidatorIR): FieldSnapshot => {
    const optional = validator.kind === "optional";
    const inner = optional ? validator.inner : undefined;
    const target = inner ?? validator;

    const snapshot: FieldSnapshot = {
        kind: optional ? (inner?.kind ?? "unknown") : validator.kind,
        nullable: target.column?.notNull === false || validator.column?.notNull === false,
        optional,
        unique: target.column?.unique === true || validator.column?.unique === true,
        // Spread LAST so the key order — which the serialization and therefore the
        // content hash depend on — is fixed by these two literals rather than by
        // the order the validator happened to be built in.
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- STRUCTURAL_DETAIL's readers recurse back into this function, so one of the two references has to precede its definition
        ...STRUCTURAL_DETAIL[target.kind]?.(target),
    };

    if (target.hasRefinement === true || validator.hasRefinement === true) {
        snapshot.refined = true;
    }

    return snapshot;
};

/** Snapshot every property of a `v.object({...})` shape, key-sorted so declaration order cannot move the hash. */
const objectFieldsOf = (shape: Record<string, ValidatorIR>): Record<string, FieldSnapshot> => {
    const fields: Record<string, FieldSnapshot> = {};

    for (const [key, member] of Object.entries(shape)) {
        fields[key] = fieldSnapshotOf(member);
    }

    return sortKeys(fields);
};

/** An `import("...")` qualifier whose specifier is an absolute path (POSIX, drive-letter or UNC), i.e. one that names a file on the machine that printed it. */
const MACHINE_LOCAL_IMPORT = /import\(\s*["'`](?:[A-Za-z]:)?[\\/]/u;

/**
 * How to read the interior of each validator kind that has one. A kind with no
 * entry contributes nothing beyond its name — which is exactly what the whole
 * snapshot used to be.
 */
const STRUCTURAL_DETAIL: Record<string, (validator: ValidatorIR) => Partial<FieldSnapshot>> = {
    array: (validator) => (validator.inner ? { of: fieldSnapshotOf(validator.inner) } : {}),
    // An `import("/abs/path").X` qualifier names a file on THIS machine: the same
    // schema snapshotted elsewhere prints differently, which would read as a
    // breaking output change nobody made. Leave it unrecorded, so it is skipped.
    // A package-qualified import (`import("@acme/schema").X`) prints the same
    // everywhere, so its output stays recorded and a change to it is seen.
    from: (validator) => (validator.tsType === undefined || MACHINE_LOCAL_IMPORT.test(validator.tsType) ? {} : { output: validator.tsType }),
    id: (validator) => (validator.tableName === undefined ? {} : { ref: validator.tableName }),
    literal: (validator) => (validator.literalValue === undefined ? {} : { literal: validator.literalValue }),
    object: (validator) => (validator.shape ? { fields: objectFieldsOf(validator.shape) } : {}),
    record: (validator) => {
        return {
            ...(validator.keyType ? { key: fieldSnapshotOf(validator.keyType) } : {}),
            ...(validator.valueType ? { of: fieldSnapshotOf(validator.valueType) } : {}),
        };
    },
    union: (validator) => (validator.members ? { members: validator.members.map((member) => fieldSnapshotOf(member)).toSorted(byCanonicalForm) } : {}),
};

/**
 * Build a deterministic structural snapshot of one table.
 *
 * Field / index / relation keys are `sortKeys`-ordered, like the table keys
 * above them. They used to be emitted in declaration order "so the snapshot
 * reads next to the schema it mirrors", but the snapshot is HASHED: declaration
 * order made moving a field up a line report drift, mint a new content hash, and
 * consume one of the ledger's `SCHEMA_HISTORY_MAX_VERSIONS` slots for an edit
 * that changed nothing on disk. Readability was the only argument for it, and a
 * sorted list is not less readable than an arbitrary one.
 */
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
        relations[relation.name] =
            relation.through === undefined
                ? { field: relation.field, kind: relation.kind, table: relation.table }
                : { kind: relation.kind, table: relation.table, through: { ...relation.through } };
    }

    // The three table-level modifiers that move or destroy rows without touching
    // a column. Each was invisible here, so a deploy that empties the table on
    // the next cold start (`.memory()`), starts deleting rows past a cutoff
    // (`.ttl()`), or leaves every existing row out of a changefeed
    // (`.commitOrdered()`) passed the gate reporting no change at all. The two
    // flags are written UNCONDITIONALLY — their absence is what dates a baseline
    // as predating them (see `recordsTableModifiers`), so writing them only when
    // true would make "this table is not a memory table" and "this format did not
    // record memory tables" the same bytes.
    const snapshot: TableSnapshot = {
        commitOrdered: table.commitOrdered === true,
        fields: sortKeys(fields),
        indexes: sortKeys(indexes),
        memory: table.memory === true,
        relations: sortKeys(relations),
        shardMode: encodeShardMode(table),
    };

    if (table.ttl) {
        // Rebuilt rather than spread: `parseTtlCall` sets `after: undefined`
        // explicitly when no offset was declared, and `JSON.stringify` drops the
        // key — so a snapshot that kept it would not deep-equal the same snapshot
        // round-tripped through the baseline file.
        snapshot.ttl = table.ttl.after === undefined ? { field: table.ttl.field } : { after: table.ttl.after, field: table.ttl.field };
    }

    return snapshot;
};

/**
 * Build a {@link SchemaSnapshot} from a parsed {@link SchemaIR} and the set of
 * declared migration ids. Tables and migration ids are sorted so the emitted
 * JSON is byte-stable across runs AND across machines (no spurious diffs /
 * churn) — see `sortKeys` in `shared/schema-snapshot.ts` for why that ordering
 * must not be locale-aware.
 *
 * Field / index / relation keys are sorted the same way, by `tableSnapshotOf` —
 * see there for why declaration order was the wrong default for a hashed file.
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

/**
 * A `.withIndex(name)` the application's own functions make: the table read, the index named (`undefined` when the name is not a
 * string literal, so any index of the table may be the one), and where. The drift gate refuses to drop an index one of these names.
 */
interface IndexReference {
    file: string;
    /** The exported function (or helper, or `<module>`) containing the read. */
    function: string;
    index: string | undefined;
    line: number;
    /** `""` when the table is not a string literal, so any table may be the one. */
    table: string;
}

/** The `.withIndex` reads among a run's discovered queries, reduced to what the index check needs. */
const indexReferencesOf = (queries: ReadonlyArray<QueryReadIR>): IndexReference[] =>
    queries.flatMap((read) =>
        read.index === undefined
            ? []
            : [
                  {
                      file: read.file,
                      function: read.scope.kind === "module" ? "<module>" : read.scope.name,
                      index: read.index.name,
                      line: read.line,
                      table: read.table,
                  },
              ],
    );

/** The decision the pre-deploy gate returns. */
interface SchemaDriftDecision {
    /** True when the deploy must be blocked (breaking drift no new migration covers, and no override). */
    blocked: boolean;
    /** Every classified change (both severities), for reporting. */
    changes: ReadonlyArray<DriftChange>;

    /**
     * Migration ids declared now but absent from the baseline. Reported for
     * context; the gate acts on which of them cover an affected TABLE, not on how
     * many there are.
     */
    newMigrationIds: ReadonlyArray<string>;

    /**
     * A multi-line, actionable explanation. Always present; empty string when
     * there is no drift at all. Mirrors the D1-placeholder guard's message style.
     */
    reason: string;

    /**
     * The breaking changes no new migration accounts for. Non-empty exactly when
     * the run blocks or an override waved it through; a caller that can read the
     * stored rows checks these.
     */
    uncovered: ReadonlyArray<DriftChange>;
}

/**
 * The override line every command that runs the gate prints. `--allow-schema-drift` checks nothing and
 * leaves the baseline where it was, so it is for a change that is backward-compatible in a way the schema
 * cannot show (every command that reaches the gate accepts it, `build` and `verify` included).
 */
const ALLOW_DRIFT_LINE =
    "  • For a change you know is safe: pass `--allow-schema-drift` to skip the block for this run. It checks nothing and leaves the baseline unchanged, so the next run drifts again.";

const remediationFlagLines = (): string => `${ALLOW_DRIFT_LINE}\n`;

/** Render one `  - <summary>` line per change, the shape every branch of the message uses. */
const summarize = (changes: ReadonlyArray<DriftChange>): string => changes.map((change) => `  - ${change.summary}`).join("\n");

/**
 * A change a `defineMigration` can actually fix, narrowed so `table` is known
 * present.
 *
 * `remediation` is carried on the change union itself (see `DriftRemediation` in
 * `shared/schema-snapshot.ts`) rather than being a set of type names maintained
 * here: a new variant must then declare what fixes it, instead of silently
 * defaulting to "a backfill" and being offered a `migrate create` line for a
 * tool that cannot touch it.
 */
const isBackfillable = (change: DriftChange): change is DriftChange & { table: string } => change.remediation === "backfill" && change.table !== undefined;

/**
 * Whether a new migration can accompany a change to clear it: a backfill (the migration rewrites the rows) or a rehome (the rows are
 * moved by an export/import round trip, and the migration gives each what its new home needs, and records that this was handled).
 */
const isCoverable = (change: DriftChange): boolean => change.remediation === "backfill" || change.remediation === "rehome";

/** An index a query still names is breaking: the shard drops it and the next request through that query throws. */
const promoteReferencedRemoval = (change: DriftChange, references: ReadonlyArray<IndexReference>): DriftChange => {
    if (change.type !== "removedIndex" || change.index === undefined) {
        return change;
    }

    const users = references.filter(
        (reference) => (reference.table === change.table || reference.table === "") && (reference.index === change.index || reference.index === undefined),
    );

    if (users.length === 0) {
        return change;
    }

    const named = users
        .slice(0, 5)
        .map(
            (reference) =>
                `${reference.function} (${reference.file}:${String(reference.line)}${reference.index === undefined ? ", index name is not a literal" : ""})`,
        )
        .join(", ");

    return {
        ...change,
        remediation: "code",
        severity: "breaking",
        summary: `removed index ${change.index ?? ""} on ${change.table ?? ""} is still used by ${named}${users.length > 5 ? ` and ${String(users.length - 5)} more` : ""} — point the query at another index, or restore the index`,
    };
};

/**
 * `lunora migrate create` requires an identifier for `--table`
 * (`packages/cli/src/commands/migrate/handler.ts`), while a schema table name is
 * an object key with no such constraint. A name it would reject must not be
 * printed as a paste-ready command.
 */
const TABLE_IDENTIFIER = /^[A-Za-z_]\w*$/u;

/** The scaffold command for a table's missing backfill, ready to paste. */
const scaffoldLine = (table: string): string => `      lunora migrate create backfill_${table} --table ${table}`;

/**
 * Render the blocked-deploy message: what is still uncovered, what to do about
 * it, and the one-run override.
 *
 * Every "to fix" line is conditional on there being something that line can fix.
 * The bullet naming `defineMigration` used to be unconditional, so a
 * jurisdiction-only block said "no in-place migration" and "add a migration" two
 * lines apart.
 */
const blockedReason = (
    uncovered: ReadonlyArray<DriftChange>,
    migrationNotes: { identity: ReadonlyArray<string>; unresolved: ReadonlyArray<string> },
    command: string | undefined,
): string => {
    const { identity: identityMigrationIds, unresolved: unresolvedMigrationIds } = migrationNotes;
    const owedTables = [...new Set(uncovered.filter((change) => isBackfillable(change)).map((change) => change.table))];
    const fixLines: string[] = [];

    if (owedTables.length > 0) {
        fixLines.push(
            "  • Add a `defineMigration({ id, table, up })` in lunora/ for each affected table, then re-run this command — the baseline is re-blessed on a successful deploy, not by `lunora migrate` itself.\n",
        );

        // A table name is an object key with no identifier constraint, but
        // `--table` requires one: printing a command that cannot run is worse
        // than printing none.
        const scaffoldable = owedTables.filter((table) => TABLE_IDENTIFIER.test(table));

        if (scaffoldable.length > 0) {
            fixLines.push(
                `\n    Scaffold the missing migration(s) — the generated \`up\` is an identity placeholder you must fill in:\n${scaffoldable.map((table) => scaffoldLine(table)).join("\n")}\n\n`,
            );
        }
    }

    // A migration whose `table` codegen could not lift to a string literal covers
    // nothing (see `evaluateSchemaDrift`). Without this line the operator has
    // written exactly the `defineMigration` the message asks for and is told to
    // write it again, with nothing connecting the two.
    if (unresolvedMigrationIds.length > 0) {
        fixLines.push(
            `  • Migration(s) ${unresolvedMigrationIds.join(", ")} declare a non-literal \`table\`, so codegen cannot tell which table they visit and they cover nothing. Use a string literal.\n`,
        );
    }

    // The scaffold's placeholder used to clear the gate the moment it existed, so a
    // forgotten `up` shipped the change with no backfill behind it.
    if (identityMigrationIds.length > 0) {
        fixLines.push(
            `  • Migration(s) ${identityMigrationIds.join(", ")} return each document unchanged, so they rewrite no row and cover nothing. Fill in \`up\`.\n`,
        );
    }

    // Named from every command: only deploy reads a deployment, but the one running offline (prepare in CI) is
    // where the operator learns that the deploy step can settle this without a migration.
    if (owedTables.length > 0) {
        fixLines.push(
            "  • If the stored rows already fit the new schema, `lunora deploy` goes ahead on its own: it reads the rows of each affected table from the deployed worker (`--migrate-url` or the project link, plus `LUNORA_ADMIN_TOKEN`) and names any row that does not fit.\n",
        );
    }

    const rehomed = uncovered.filter((change) => change.remediation === "rehome");

    if (rehomed.length > 0) {
        const example = rehomed.find((change) => change.table !== undefined)?.table ?? "users";

        fixLines.push(
            "  • These changes move or empty data, so they stay blocked until a new migration on the affected table accompanies them, once the rows are moved. " +
                `Example for \`${example}\`: export the rows (\`lunora export --tables ${example} --out ${example}.ndjson\`), deploy, load them back (\`lunora import ${example}.ndjson\`), and declare in lunora/ ` +
                `\`defineMigration({ id: "rehome_${example}", table: "${example}", up: (doc) => ({ ...doc, tenantId: doc.tenantId ?? "default" }) })\` (give each row whatever its new home needs, here a shard key). ` +
                "A migration whose `up` returns the document unchanged covers nothing.\n",
        );
    }

    fixLines.push(remediationFlagLines());

    return [
        // NOT "…not covered by a new migration": only a `"backfill"` change ever
        // could be, so that phrasing would misdescribe why a dropped index or a
        // shard-mode flip is in this list. Each summary states its own fix.
        // Name the command the operator actually ran. Hardcoding "deploy" meant
        // `lunora prepare` and `lunora build` both reported a deploy being
        // blocked when no deploy had been attempted — sending the reader to look
        // for a deployment that does not exist.
        `${command ?? "deploy"} blocked: ${String(uncovered.length)} unresolved breaking schema change(s) since the last blessed schema baseline:`,
        summarize(uncovered),
        "",
        `To fix:\n${fixLines.join("")}Docs: https://lunora.dev/docs/migrations`,
    ].join("\n");
};

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
 * The shard-mode diff cites this block to justify the studio not shipping a
 * stranded-rows detector (see `shared/schema-snapshot.ts`), and that claim only
 * holds if an unrelated migration cannot wave it through.
 *
 * Only a `"backfill"` or `"rehome"` change is coverable. A `"code"` change breaks
 * a call site (a dropped index a query still names); rewriting rows fixes neither,
 * so a migration must not excuse it however well its table matches. It is cleared
 * by fixing the code (`--allow-schema-drift` skips it for one run).
 */
const evaluateSchemaDrift = (options: {
    allowDrift?: boolean;
    baseline: SchemaSnapshot | undefined;
    /** The command printing the remediation, so it names only flags that command accepts. */
    command?: string;
    current: SchemaSnapshot;
    /** The `.withIndex` reads the application makes, so a dropped index a query still names is refused. */
    indexReferences?: ReadonlyArray<IndexReference>;
    /** This run's declared migrations, so a new one is matched to the table it iterates. */
    migrations: ReadonlyArray<Pick<MigrationIR, "id" | "identity" | "table">>;
}): SchemaDriftDecision => {
    const { allowDrift = false, baseline, command, current, indexReferences = [], migrations } = options;
    const drift = { changes: diffSchemaSnapshots(baseline, current).changes.map((change) => promoteReferencedRemoval(change, indexReferences)) };
    const breaking = drift.changes.filter((change) => change.severity === "breaking");
    const newMigrationIds = current.migrationIds.filter((id) => !(baseline?.migrationIds ?? []).includes(id));
    const newMigrations = migrations.filter((migration) => newMigrationIds.includes(migration.id));
    const decide = (blocked: boolean, reason: string, uncovered: ReadonlyArray<DriftChange> = []): SchemaDriftDecision => {
        return { blocked, changes: drift.changes, newMigrationIds, reason, uncovered };
    };

    // Tables a NEW migration iterates. A migration whose `table` is `""` — not a
    // static string literal, so codegen could not lift it — covers nothing rather
    // than everything: failing closed keeps an unresolvable declaration from
    // becoming a blanket override. `blockedReason` names those ids, so failing
    // closed does not also fail silently.
    // An identity `up` covers nothing either: it rewrites no row, so whether its table's rows fit is a question
    // only the stored rows can answer.
    const coveredTables = new Set(
        newMigrations.filter((migration) => migration.table !== "" && migration.identity !== true).map((migration) => migration.table),
    );
    const unresolvedMigrationIds = newMigrations.filter((migration) => migration.table === "").map((migration) => migration.id);
    const identityMigrationIds = newMigrations.filter((migration) => migration.table !== "" && migration.identity === true).map((migration) => migration.id);

    // No drift at all, or a first-ever capture (no baseline to compare against) —
    // never block.
    if (drift.changes.length === 0 || baseline === undefined) {
        return decide(false, "");
    }

    if (breaking.length === 0) {
        return decide(false, `schema drift detected (all additive/safe):\n${summarize(drift.changes)}`);
    }

    // Only a `"backfill"` change is coverable, and only by a migration on its own
    // table. `"rehome"` rows move to another Durable Object or region, which no
    // per-shard transform reaches; a `"code"` change breaks a CALL SITE (a query
    // that named a dropped index or relation), which rewriting rows cannot repair
    // either — letting a same-table migration excuse one would ship a deploy whose
    // callers still fail at runtime. Both are resolved by fixing the code or
    // accepting the shape, which is what the message says.
    // A change with no table (a jurisdiction change re-homes every Durable Object) is covered by any new migration that rewrites rows.
    const uncovered = breaking.filter(
        (change) => !isCoverable(change) || !(change.table === undefined ? coveredTables.size > 0 : coveredTables.has(change.table)),
    );

    if (uncovered.length === 0) {
        // Name the migrations that actually covered something, not every new id —
        // counting ids indiscriminately is the habit this gate exists to break. A
        // migration on a table with no breaking drift covered nothing.
        const driftedTables = new Set(breaking.map((change) => change.table));
        const schemaWide = breaking.some((change) => change.table === undefined);
        const covering = newMigrations
            .filter((migration) => migration.identity !== true && migration.table !== "" && (schemaWide || driftedTables.has(migration.table)))
            .map((migration) => migration.id);

        return decide(
            false,
            `breaking schema drift detected, covered by ${String(covering.length)} new migration(s) (${covering.join(", ")}):\n${summarize(breaking)}`,
        );
    }

    const reason = blockedReason(uncovered, { identity: identityMigrationIds, unresolved: unresolvedMigrationIds }, command);

    if (allowDrift) {
        return decide(false, `${reason}\n\n(overridden by --allow-schema-drift)`, uncovered);
    }

    return decide(true, reason, uncovered);
};

export type { SchemaDriftDecision };
export type { IndexReference };
export { buildSchemaSnapshot, evaluateSchemaDrift, indexReferencesOf, parseSchemaSnapshot, SchemaSnapshotParseError };
