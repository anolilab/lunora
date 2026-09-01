import { describe, expect, it } from "vitest";

import { diffSchemaSnapshots, hashSchemaSnapshot, SCHEMA_SNAPSHOT_VERSION, serializeSchemaSnapshot } from "../../../shared/schema-snapshot";
import type { SchemaIR, TableIR } from "../src/ir";
import { buildSchemaSnapshot, evaluateSchemaDrift, parseSchemaSnapshot, SchemaSnapshotParseError } from "../src/schema-drift";

/** Build a minimal `TableIR` with the given field shape; extras (indexes/relations/shardMode) optional. */
const table = (name: string, shape: TableIR["shape"], extra: Partial<TableIR> = {}): TableIR => {
    return {
        indexes: [],
        name,
        rankIndexes: [],
        relations: [],
        searchIndexes: [],
        shape,
        shardMode: "root",
        vectorIndexes: [],
        ...extra,
    };
};

const schema = (tables: TableIR[]): SchemaIR => {
    return { tables, vectorIndexes: [] };
};

const stringField = { kind: "string" } as const;
const numberField = { kind: "number" } as const;
const optionalString = { inner: { kind: "string" }, kind: "optional" } as const;

describe("schema-drift", () => {
    describe("buildSchemaSnapshot", () => {
        it("captures field kinds + optionality, sorts tables and migration ids", () => {
            expect.assertions(4);

            const snapshot = buildSchemaSnapshot(
                schema([table("users", { name: stringField, nickname: optionalString }), table("messages", { text: stringField })]),
                ["m2", "m1"],
            );

            // tables sorted alphabetically (messages before users)
            expect(Object.keys(snapshot.tables)).toStrictEqual(["messages", "users"]);
            expect(snapshot.tables.users?.fields.nickname).toStrictEqual({ kind: "string", nullable: false, optional: true, unique: false });
            expect(snapshot.tables.users?.fields.name).toStrictEqual({ kind: "string", nullable: false, optional: false, unique: false });
            // migration ids sorted
            expect(snapshot.migrationIds).toStrictEqual(["m1", "m2"]);
        });

        it("orders tables and migration ids by code unit, not locale collation", () => {
            expect.assertions(2);

            /*
             * `.lunora-schema.json` is committed, so its byte order must not depend
             * on the machine that generated it. `localeCompare` resolves against the
             * runtime's default locale and ICU version — under ICU collation "a"
             * sorts BEFORE "B", while by code unit "B" (0x42) sorts before "a"
             * (0x61). These fixtures are chosen so the two orderings disagree: a
             * regression to a locale-aware comparator flips both assertions.
             */
            const snapshot = buildSchemaSnapshot(
                schema([table("apples", { x: stringField }), table("Berries", { x: stringField }), table("_hidden", { x: stringField })]),
                ["b_two", "A_one"],
            );

            expect(Object.keys(snapshot.tables)).toStrictEqual(["Berries", "_hidden", "apples"]);
            expect(snapshot.migrationIds).toStrictEqual(["A_one", "b_two"]);
        });

        it("encodes shard mode as a stable string", () => {
            expect.assertions(3);

            const snapshot = buildSchemaSnapshot(
                schema([
                    table("a", { x: stringField }),
                    table("b", { x: stringField }, { shardMode: "global" }),
                    table("c", { x: stringField }, { shardMode: { field: "tenantId", kind: "shardBy" } }),
                ]),
                [],
            );

            expect(snapshot.tables.a?.shardMode).toBe("root");
            expect(snapshot.tables.b?.shardMode).toBe("global");
            expect(snapshot.tables.c?.shardMode).toBe("shardBy:tenantId");
        });
    });

    describe("serialize / parse round-trip", () => {
        it("round-trips a snapshot and treats only absent/empty content as undefined", () => {
            expect.assertions(4);

            const snapshot = buildSchemaSnapshot(schema([table("users", { name: stringField })]), ["m1"]);
            const serialized = serializeSchemaSnapshot(snapshot);

            expect(serialized.endsWith("\n")).toBe(true);
            expect(parseSchemaSnapshot(serialized)).toStrictEqual(snapshot);
            // Absent / empty / whitespace ⇒ no baseline yet (a legitimate first capture).
            expect(parseSchemaSnapshot(undefined)).toBeUndefined();
            expect(parseSchemaSnapshot("   \n  ")).toBeUndefined();
        });

        it("throws SchemaSnapshotParseError on present-but-malformed content (so corruption is not a silent first capture)", () => {
            expect.assertions(3);

            // Invalid JSON.
            expect(() => parseSchemaSnapshot("not json")).toThrow(SchemaSnapshotParseError);
            // Right JSON, wrong version.
            expect(() => parseSchemaSnapshot(JSON.stringify({ tables: {}, version: 999 }))).toThrow(SchemaSnapshotParseError);
            // Right version, structurally-invalid table entry (fields not an object).
            expect(() => parseSchemaSnapshot(JSON.stringify({ tables: { users: { fields: "nope" } }, version: SCHEMA_SNAPSHOT_VERSION }))).toThrow(
                SchemaSnapshotParseError,
            );
        });
    });

    describe("diffSchemaSnapshots classification", () => {
        const baseline = buildSchemaSnapshot(schema([table("users", { age: numberField, name: stringField })]), []);

        it("treats a brand-new optional field as safe and a new required field as breaking", () => {
            expect.assertions(2);

            const safe = diffSchemaSnapshots(
                baseline,
                buildSchemaSnapshot(schema([table("users", { age: numberField, bio: optionalString, name: stringField })]), []),
            );
            const breaking = diffSchemaSnapshots(
                baseline,
                buildSchemaSnapshot(schema([table("users", { age: numberField, name: stringField, role: stringField })]), []),
            );

            expect(safe.changes).toStrictEqual([
                {
                    remediation: "none",
                    scope: "table",
                    severity: "safe",
                    summary: "added optional field users.bio",
                    table: "users",
                    type: "addedOptionalField",
                },
            ]);
            expect(breaking.changes.some((c) => c.type === "addedRequiredField" && c.severity === "breaking")).toBe(true);
        });

        it("flags dropped fields, type changes, and optional→required as breaking", () => {
            expect.assertions(3);

            const dropped = diffSchemaSnapshots(baseline, buildSchemaSnapshot(schema([table("users", { name: stringField })]), []));
            const retyped = diffSchemaSnapshots(baseline, buildSchemaSnapshot(schema([table("users", { age: stringField, name: stringField })]), []));
            const tightened = diffSchemaSnapshots(
                buildSchemaSnapshot(schema([table("users", { name: optionalString })]), []),
                buildSchemaSnapshot(schema([table("users", { name: stringField })]), []),
            );

            expect(dropped.changes.some((c) => c.type === "removedField" && c.severity === "breaking")).toBe(true);
            expect(retyped.changes.some((c) => c.type === "changedFieldKind" && c.severity === "breaking")).toBe(true);
            expect(tightened.changes.some((c) => c.type === "fieldOptionalToRequired" && c.severity === "breaking")).toBe(true);
        });

        it("treats required→optional widening and a new table as safe", () => {
            expect.assertions(2);

            const widened = diffSchemaSnapshots(
                buildSchemaSnapshot(schema([table("users", { name: stringField })]), []),
                buildSchemaSnapshot(schema([table("users", { name: optionalString })]), []),
            );
            const newTable = diffSchemaSnapshots(
                baseline,
                buildSchemaSnapshot(schema([table("users", { age: numberField, name: stringField }), table("posts", { title: stringField })]), []),
            );

            expect(widened.changes).toStrictEqual([
                {
                    remediation: "none",
                    scope: "table",
                    severity: "safe",
                    summary: "field users.name became optional",
                    table: "users",
                    type: "fieldRequiredToOptional",
                },
            ]);
            expect(newTable.changes.some((c) => c.type === "addedTable" && c.severity === "safe")).toBe(true);
        });

        it("flags a dropped table, removed index, removed relation, and changed shard mode as breaking", () => {
            expect.assertions(4);

            const withExtras = buildSchemaSnapshot(
                schema([
                    table(
                        "users",
                        { name: stringField },
                        {
                            indexes: [{ fields: ["name"], name: "by_name", unique: false }],
                            relations: [{ field: "authorId", kind: "many", name: "posts", references: "_id", table: "posts" }],
                        },
                    ),
                    table("posts", { title: stringField }),
                ]),
                [],
            );

            const dropped = diffSchemaSnapshots(withExtras, buildSchemaSnapshot(schema([table("users", { name: stringField })]), []));
            const reshard = diffSchemaSnapshots(
                buildSchemaSnapshot(schema([table("users", { name: stringField })]), []),
                buildSchemaSnapshot(schema([table("users", { name: stringField }, { shardMode: { field: "tenantId", kind: "shardBy" } })]), []),
            );

            expect(dropped.changes.some((c) => c.type === "removedTable" && c.severity === "breaking")).toBe(true);
            expect(dropped.changes.some((c) => c.type === "removedIndex" && c.severity === "breaking")).toBe(true);
            expect(dropped.changes.some((c) => c.type === "removedRelation" && c.severity === "breaking")).toBe(true);
            expect(reshard.changes.some((c) => c.type === "changedShardMode" && c.severity === "breaking")).toBe(true);
        });
    });

    describe("evaluateSchemaDrift gate", () => {
        const baseline = buildSchemaSnapshot(schema([table("users", { name: stringField })]), []);

        it("passes additive-only drift (new optional field)", () => {
            expect.assertions(2);

            const current = buildSchemaSnapshot(schema([table("users", { bio: optionalString, name: stringField })]), []);
            const decision = evaluateSchemaDrift({ baseline, current, migrations: [] });

            expect(decision.blocked).toBe(false);
            expect(decision.reason).toContain("additive/safe");
        });

        it("blocks breaking drift when no new migration was added", () => {
            expect.assertions(3);

            const current = buildSchemaSnapshot(schema([table("users", { name: numberField })]), []);
            const decision = evaluateSchemaDrift({ baseline, current, migrations: [] });

            expect(decision.blocked).toBe(true);
            expect(decision.reason).toContain("deploy blocked");
            expect(decision.reason).toContain("changed type");
        });

        it("names the command that ran, not `deploy`, and offers only the flags that command accepts", () => {
            expect.assertions(4);

            // `lunora build` reaches this gate through `runDeployCommand({ dryRun: true })`.
            // It used to report "deploy blocked:" — sending the operator to look for a
            // deployment that was never attempted — and to offer
            // `--update-schema-baseline`, which `build` rejects with a raw
            // `Found unknown option` stack trace. Both halves of its own advice failed.
            const current = buildSchemaSnapshot(schema([table("users", { name: numberField })]), []);
            const decision = evaluateSchemaDrift({ baseline, command: "build", current, migrations: [] });

            expect(decision.blocked).toBe(true);
            expect(decision.reason).toContain("build blocked");
            expect(decision.reason).not.toContain("deploy blocked");

            // `build` publishes nothing, so re-blessing a baseline from it would
            // advance past a breaking change that never shipped.
            expect(decision.reason).toContain("`lunora build` does not take that flag");
        });

        it("passes breaking drift when a NEW migration covers the affected table", () => {
            expect.assertions(3);

            const current = buildSchemaSnapshot(schema([table("users", { name: numberField })]), ["fix-name-type"]);
            const decision = evaluateSchemaDrift({ baseline, current, migrations: [{ id: "fix-name-type", table: "users" }] });

            expect(decision.blocked).toBe(false);
            expect(decision.newMigrationIds).toStrictEqual(["fix-name-type"]);
            expect(decision.reason).toContain("covered by");
        });

        it("blocks when the NEW migration targets a DIFFERENT table than the breaking change", () => {
            // The hole the per-table match closes: counting new ids alone, a
            // backfill on `messages` reported the `users` change as
            // "accompanied by a migration" that would never visit it.
            expect.assertions(2);

            const current = buildSchemaSnapshot(schema([table("users", { name: numberField }), table("messages", { body: stringField })]), [
                "backfill-messages",
            ]);
            const decision = evaluateSchemaDrift({ baseline, current, migrations: [{ id: "backfill-messages", table: "messages" }] });

            expect(decision.blocked).toBe(true);
            expect(decision.reason).toContain("unresolved breaking schema change");
        });

        it("blocks a migration whose table codegen could not lift to a literal, and says so", () => {
            // Failing closed is right; failing closed SILENTLY is not — the
            // operator wrote exactly the `defineMigration` the message asks for.
            expect.assertions(2);

            const current = buildSchemaSnapshot(schema([table("users", { name: numberField })]), ["dynamic"]);
            const decision = evaluateSchemaDrift({ baseline, current, migrations: [{ id: "dynamic", table: "" }] });

            expect(decision.blocked).toBe(true);
            expect(decision.reason).toContain("Migration(s) dynamic declare a non-literal `table`");
        });

        it("a shard-mode change stays blocked even with a migration on that very table", () => {
            // `defineMigration` runs inside one shard and can only replace the row
            // it was handed, so it can never re-home rows. The studio cites this
            // block to justify not shipping a stranded-rows detector.
            expect.assertions(3);

            const current = buildSchemaSnapshot(schema([table("users", { name: stringField }, { shardMode: { field: "tenantId", kind: "shardBy" } })]), [
                "rehome-users",
            ]);
            const decision = evaluateSchemaDrift({ baseline, current, migrations: [{ id: "rehome-users", table: "users" }] });

            expect(decision.blocked).toBe(true);
            // …and it must not name the tool that cannot work — neither as a
            // scaffold line nor as the bullet above it.
            expect(decision.reason).not.toContain("lunora migrate create");
            expect(decision.reason).not.toContain("defineMigration");
        });

        it("a dropped index stays blocked even with a migration on that very table", () => {
            // Rewriting rows cannot repair a query that named the index. Letting a
            // same-table migration excuse it would ship a deploy whose callers
            // still fail at runtime — the flags are the honest escape.
            expect.assertions(2);

            const indexed = buildSchemaSnapshot(schema([table("users", { name: stringField }, { indexes: [{ fields: ["name"], name: "byName" }] })]), []);
            const current = buildSchemaSnapshot(schema([table("users", { name: stringField })]), ["touch-users"]);
            const decision = evaluateSchemaDrift({ baseline: indexed, current, migrations: [{ id: "touch-users", table: "users" }] });

            expect(decision.blocked).toBe(true);
            expect(decision.reason).toContain("removed index byName");
        });

        it("offers no migration for a dropped index — that is a code change, not a backfill", () => {
            // A row transform cannot restore DDL. Offering `migrate create` here
            // sends the operator to the one tool guaranteed not to work.
            expect.assertions(3);

            const indexed = buildSchemaSnapshot(schema([table("users", { name: stringField }, { indexes: [{ fields: ["name"], name: "byName" }] })]), []);
            const current = buildSchemaSnapshot(schema([table("users", { name: stringField })]), []);
            const { blocked, reason } = evaluateSchemaDrift({ baseline: indexed, current, migrations: [] });

            expect(blocked).toBe(true);
            expect(reason).toContain("removed index byName");
            expect(reason).not.toContain("lunora migrate create");
        });

        it("offers no migration for a dropped table — its rows are unreachable, not transformable", () => {
            expect.assertions(2);

            const current = buildSchemaSnapshot(schema([table("messages", { body: stringField })]), []);
            const { blocked, reason } = evaluateSchemaDrift({ baseline, current, migrations: [] });

            expect(blocked).toBe(true);
            expect(reason).not.toContain("lunora migrate create");
        });

        it("prints a paste-ready scaffold command for each table still owed a backfill", () => {
            expect.assertions(3);

            const current = buildSchemaSnapshot(schema([table("users", { name: numberField })]), []);
            const { reason } = evaluateSchemaDrift({ baseline, current, migrations: [] });

            expect(reason).toContain("Scaffold the missing migration(s)");
            expect(reason).toContain("lunora migrate create backfill_users --table users");
            // The generated `up` is `(document) => document`, which would clear the
            // block without backfilling a row. Say so.
            expect(reason).toContain("identity placeholder you must fill in");
        });

        it("suppresses the scaffold line for a table name `migrate create` would reject", () => {
            // Table names are object keys with no identifier constraint; `--table`
            // requires one. Printing a command that cannot run is worse than none.
            expect.assertions(2);

            const odd = buildSchemaSnapshot(schema([table("user-profiles", { name: stringField })]), []);
            const current = buildSchemaSnapshot(schema([table("user-profiles", { name: numberField })]), []);
            const { blocked, reason } = evaluateSchemaDrift({ baseline: odd, current, migrations: [] });

            expect(blocked).toBe(true);
            expect(reason).not.toContain("lunora migrate create");
        });

        it("blocks on only the tables a partial set of migrations left uncovered", () => {
            expect.assertions(4);

            const twoTables = buildSchemaSnapshot(schema([table("users", { name: stringField }), table("posts", { title: stringField })]), []);
            const current = buildSchemaSnapshot(schema([table("users", { name: numberField }), table("posts", { title: numberField })]), ["fix-users"]);
            const { blocked, reason } = evaluateSchemaDrift({ baseline: twoTables, current, migrations: [{ id: "fix-users", table: "users" }] });

            expect(blocked).toBe(true);
            // The covered table is neither listed as a problem nor scaffolded…
            expect(reason).not.toContain("field users.name changed type");
            expect(reason).not.toContain("--table users");
            // …and the uncovered one is.
            expect(reason).toContain("lunora migrate create backfill_posts --table posts");
        });

        it("names only the migrations that covered something, not every new id", () => {
            expect.assertions(2);

            const current = buildSchemaSnapshot(schema([table("users", { name: numberField })]), ["fix-users", "unrelated"]);
            const { blocked, reason } = evaluateSchemaDrift({
                baseline,
                current,
                migrations: [
                    { id: "fix-users", table: "users" },
                    { id: "unrelated", table: "messages" },
                ],
            });

            expect(blocked).toBe(false);
            expect(reason).toContain("covered by 1 new migration(s) (fix-users)");
        });

        it("passes breaking drift when overridden with allowDrift", () => {
            expect.assertions(2);

            const current = buildSchemaSnapshot(schema([table("users", { name: numberField })]), []);
            const decision = evaluateSchemaDrift({ allowDrift: true, baseline, current, migrations: [] });

            expect(decision.blocked).toBe(false);
            expect(decision.reason).toContain("overridden by --allow-schema-drift");
        });

        describe("remediation names only the flags the printing command accepts", () => {
            // The message used to list both flags unconditionally, so following it
            // verbatim failed: `build` accepts neither and `verify` accepts only
            // `--allow-schema-drift`. This is the message a first-time deployer
            // hits, and half its own advice did not work.
            const breaking = (): ReturnType<typeof buildSchemaSnapshot> => buildSchemaSnapshot(schema([table("users", { name: numberField })]), []);

            it("offers both flags on deploy", () => {
                expect.assertions(2);

                const { reason } = evaluateSchemaDrift({ baseline, command: "deploy", current: breaking(), migrations: [] });

                expect(reason).toContain("--allow-schema-drift");
                expect(reason).toContain("--update-schema-baseline");
            });

            it("offers only --allow-schema-drift on verify, and points at prepare for the other", () => {
                expect.assertions(3);

                const { reason } = evaluateSchemaDrift({ baseline, command: "verify", current: breaking(), migrations: [] });

                expect(reason).toContain("pass `--allow-schema-drift`");
                expect(reason).toContain("lunora prepare --update-schema-baseline");
                expect(reason).toContain("`lunora verify` does not take that flag");
            });

            it("falls back to listing both when the caller is unknown", () => {
                expect.assertions(2);

                const { reason } = evaluateSchemaDrift({ baseline, current: breaking(), migrations: [] });

                expect(reason).toContain("--allow-schema-drift");
                expect(reason).toContain("--update-schema-baseline");
            });
        });

        it("never blocks a first-ever capture (no baseline)", () => {
            expect.assertions(1);

            const current = buildSchemaSnapshot(schema([table("users", { name: stringField })]), []);
            const decision = evaluateSchemaDrift({ baseline: undefined, current, migrations: [] });

            expect(decision.blocked).toBe(false);
        });

        it("a re-added migration id (already in baseline) does not satisfy the gate", () => {
            expect.assertions(1);

            const withMigration = buildSchemaSnapshot(schema([table("users", { name: stringField })]), ["m1"]);
            // breaking change but the only migration id is the same one the baseline already knew.
            const current = buildSchemaSnapshot(schema([table("users", { name: numberField })]), ["m1"]);
            const decision = evaluateSchemaDrift({ baseline: withMigration, current, migrations: [{ id: "m1", table: "users" }] });

            expect(decision.blocked).toBe(true);
        });
    });

    it("exposes the snapshot version", () => {
        expect.assertions(1);

        expect(SCHEMA_SNAPSHOT_VERSION).toBe(1);
    });

    describe("jurisdiction drift", () => {
        const pinned = (jurisdiction: SchemaIR["jurisdiction"]): SchemaIR => {
            return { jurisdiction, tables: [table("users", { name: stringField })], vectorIndexes: [] };
        };

        it("captures the schema jurisdiction into the snapshot", () => {
            expect.assertions(1);

            expect(buildSchemaSnapshot(pinned("us"), []).jurisdiction).toBe("us");
        });

        it("survives a serialize / parse round-trip", () => {
            expect.assertions(1);

            const parsed = parseSchemaSnapshot(serializeSchemaSnapshot(buildSchemaSnapshot(pinned("eu"), [])));

            expect(parsed?.jurisdiction).toBe("eu");
        });

        it("parses a pre-jurisdiction baseline (field absent) as undefined", () => {
            expect.assertions(1);

            // A v1 baseline written before the field existed: no `jurisdiction` key.
            const legacy = JSON.stringify({ migrationIds: [], tables: {}, version: SCHEMA_SNAPSHOT_VERSION });

            expect(parseSchemaSnapshot(legacy)?.jurisdiction).toBeUndefined();
        });

        it("preserves an unknown jurisdiction string (forward-compat downgrade) instead of dropping it", () => {
            expect.assertions(2);

            // A baseline written by a newer Lunora that supports a jurisdiction this
            // version doesn't know yet. Coercing it to `undefined` would fail open and
            // hide a `changedJurisdiction` drift, so it must round-trip verbatim.
            const future = JSON.stringify({ jurisdiction: "apac", migrationIds: [], tables: {}, version: SCHEMA_SNAPSHOT_VERSION });
            const baseline = parseSchemaSnapshot(future);

            expect(baseline?.jurisdiction).toBe("apac");

            // Removing the (unknown) jurisdiction is still flagged as breaking drift.
            const change = diffSchemaSnapshots(baseline, buildSchemaSnapshot(schema([table("users", { name: stringField })]), [])).changes.find(
                (candidate) => candidate.type === "changedJurisdiction",
            );

            expect(change?.severity).toBe("breaking");
        });

        it("flags adding a jurisdiction as breaking drift", () => {
            expect.assertions(3);

            const baseline = buildSchemaSnapshot(schema([table("users", { name: stringField })]), []);
            const current = buildSchemaSnapshot(pinned("us"), []);

            const change = diffSchemaSnapshots(baseline, current).changes.find((candidate) => candidate.type === "changedJurisdiction");

            expect(change).toBeDefined();
            expect(change?.severity).toBe("breaking");
            expect(change?.summary).toContain("strands all existing");
        });

        it("flags changing the jurisdiction as breaking drift", () => {
            expect.assertions(1);

            const change = diffSchemaSnapshots(buildSchemaSnapshot(pinned("eu"), []), buildSchemaSnapshot(pinned("us"), [])).changes.find(
                (candidate) => candidate.type === "changedJurisdiction",
            );

            expect(change?.severity).toBe("breaking");
        });

        it("reports no jurisdiction drift when it is unchanged", () => {
            expect.assertions(1);

            const { changes } = diffSchemaSnapshots(buildSchemaSnapshot(pinned("us"), []), buildSchemaSnapshot(pinned("us"), []));

            expect(changes.some((candidate) => candidate.type === "changedJurisdiction")).toBe(false);
        });

        it("does not flag jurisdiction on a first-ever capture (no baseline)", () => {
            expect.assertions(1);

            const { changes } = diffSchemaSnapshots(undefined, buildSchemaSnapshot(pinned("us"), []));

            expect(changes.some((candidate) => candidate.type === "changedJurisdiction")).toBe(false);
        });
    });

    /*
     * A snapshot of only `{ kind, optional }` was byte-identical across every
     * change INSIDE a validator, so each of these produced zero drift, an
     * unchanged baseline file, and — because `recordSchemaVersion` keys on the
     * content hash — no ledger row either.
     */
    describe("validator interior", () => {
        /** The three signals a change has to move: a classified drift change, the serialized bytes, and the content hash. */
        const compare = (before: TableIR["shape"], after: TableIR["shape"]) => {
            const baseline = buildSchemaSnapshot(schema([table("users", before)]), []);
            const current = buildSchemaSnapshot(schema([table("users", after)]), []);

            return {
                changes: diffSchemaSnapshots(baseline, current).changes,
                hashMoved: hashSchemaSnapshot(baseline) !== hashSchemaSnapshot(current),
                serializationMoved: serializeSchemaSnapshot(baseline) !== serializeSchemaSnapshot(current),
            };
        };

        it("sees a repointed `v.id()` foreign key", () => {
            expect.assertions(4);

            const { changes, hashMoved, serializationMoved } = compare(
                { owner: { kind: "id", tableName: "users" } },
                { owner: { kind: "id", tableName: "orgs" } },
            );

            expect(changes).toHaveLength(1);
            expect(changes[0]).toMatchObject({ remediation: "backfill", severity: "breaking", type: "changedFieldShape" });
            expect(changes[0]?.summary).toContain("id(users) → id(orgs)");
            expect([hashMoved, serializationMoved]).toStrictEqual([true, true]);
        });

        it("sees an array element type change (it moves the storage projection)", () => {
            expect.assertions(3);

            const { changes, hashMoved } = compare(
                { tags: { inner: { kind: "string" }, kind: "array" } },
                { tags: { inner: { kind: "bigint" }, kind: "array" } },
            );

            expect(changes).toHaveLength(1);
            expect(changes[0]).toMatchObject({ severity: "breaking", type: "changedFieldShape" });
            expect(hashMoved).toBe(true);
        });

        it("sees an object property and a record value type change", () => {
            expect.assertions(2);

            const object = compare(
                { profile: { kind: "object", shape: { a: { kind: "string" } } } },
                { profile: { kind: "object", shape: { a: { kind: "number" } } } },
            );
            const record = compare(
                { counts: { keyType: { kind: "string" }, kind: "record", valueType: { kind: "string" } } },
                { counts: { keyType: { kind: "string" }, kind: "record", valueType: { kind: "bigint" } } },
            );

            expect(object.changes.map((change) => change.severity)).toStrictEqual(["breaking"]);
            expect(record.changes.map((change) => change.severity)).toStrictEqual(["breaking"]);
        });

        it("sees a changed literal", () => {
            expect.assertions(2);

            const { changes, hashMoved } = compare({ tier: { kind: "literal", literalValue: '"a"' } }, { tier: { kind: "literal", literalValue: '"b"' } });

            expect(changes.map((change) => change.type)).toStrictEqual(["changedFieldShape"]);
            expect(hashMoved).toBe(true);
        });

        it("flags a swapped union member as breaking but a widened union as safe", () => {
            expect.assertions(3);

            const swapped = compare(
                { value: { kind: "union", members: [{ kind: "string" }, { kind: "number" }] } },
                { value: { kind: "union", members: [{ kind: "string" }, { kind: "boolean" }] } },
            );
            const widened = compare({ value: { kind: "string" } }, { value: { kind: "union", members: [{ kind: "string" }, { kind: "number" }] } });
            const narrowed = compare({ value: { kind: "union", members: [{ kind: "string" }, { kind: "number" }] } }, { value: { kind: "string" } });

            expect(swapped.changes.map((change) => change.severity)).toStrictEqual(["breaking"]);
            // Widening accepts everything the old shape did, so nothing stored becomes invalid.
            expect(widened.changes.map((change) => [change.severity, change.type])).toStrictEqual([["safe", "widenedFieldShape"]]);
            expect(narrowed.changes.map((change) => change.severity)).toStrictEqual(["breaking"]);
        });

        it("treats a reordered union as no change at all — a union is a set", () => {
            expect.assertions(2);

            const { changes, hashMoved } = compare(
                { value: { kind: "union", members: [{ kind: "string" }, { kind: "number" }] } },
                { value: { kind: "union", members: [{ kind: "number" }, { kind: "string" }] } },
            );

            expect(changes).toStrictEqual([]);
            expect(hashMoved).toBe(false);
        });

        it("classifies tightening a constraint as breaking and relaxing it as safe", () => {
            expect.assertions(4);

            const plain = { kind: "string" } as const;
            const unique = { column: { notNull: true, unique: true }, kind: "string" } as const;
            const nullable = { column: { notNull: false }, kind: "string" } as const;

            expect(compare({ email: plain }, { email: unique }).changes.map((change) => [change.severity, change.type])).toStrictEqual([
                ["breaking", "addedFieldConstraint"],
            ]);
            expect(compare({ email: unique }, { email: plain }).changes.map((change) => [change.severity, change.type])).toStrictEqual([
                ["safe", "relaxedFieldConstraint"],
            ]);
            // `.nullable()` removed: every row holding NULL is now invalid.
            expect(compare({ email: nullable }, { email: plain }).changes.map((change) => change.severity)).toStrictEqual(["breaking"]);
            expect(compare({ email: plain }, { email: nullable }).changes.map((change) => change.severity)).toStrictEqual(["safe"]);
        });

        it("reads `.unique()` through `v.optional()` whichever node the chain recorded it on", () => {
            expect.assertions(2);

            const onInner = buildSchemaSnapshot(
                schema([table("users", { email: { inner: { column: { notNull: true, unique: true }, kind: "string" }, kind: "optional" } })]),
                [],
            );
            const onWrapper = buildSchemaSnapshot(
                schema([table("users", { email: { column: { notNull: true, unique: true }, inner: { kind: "string" }, kind: "optional" } })]),
                [],
            );

            expect(onInner.tables.users?.fields.email?.unique).toBe(true);
            expect(onWrapper.tables.users?.fields.email?.unique).toBe(true);
        });

        it("does not report drift for detail a pre-deepening baseline never recorded", () => {
            expect.assertions(1);

            /*
             * The shape a baseline written before the deepening has on disk. Every
             * app has one, and reporting a breaking change per constrained field on
             * the first run after upgrading is how `--allow-schema-drift` becomes
             * reflexive.
             */
            const legacy = {
                jurisdiction: undefined,
                migrationIds: [],
                tables: { users: { fields: { email: { kind: "string", optional: false } }, indexes: {}, relations: {}, shardMode: "root" } },
                version: SCHEMA_SNAPSHOT_VERSION,
            } as const;

            const current = buildSchemaSnapshot(schema([table("users", { email: { column: { notNull: false, unique: true }, kind: "string" } })]), []);

            expect(diffSchemaSnapshots(legacy, current).changes).toStrictEqual([]);
        });

        it("keeps the serialization independent of field, index and object-property declaration order", () => {
            expect.assertions(2);

            const shapeA = { profile: { kind: "object", shape: { a: { kind: "string" }, b: { kind: "number" } } }, zed: { kind: "string" } } as const;
            const shapeB = { profile: { kind: "object", shape: { b: { kind: "number" }, a: { kind: "string" } } }, zed: { kind: "string" } } as const;

            const first = buildSchemaSnapshot(
                schema([
                    table(
                        "users",
                        { ...shapeA },
                        {
                            indexes: [
                                { fields: ["zed"], name: "by_zed" },
                                { fields: ["a"], name: "by_a" },
                            ],
                        },
                    ),
                ]),
                [],
            );
            const second = buildSchemaSnapshot(
                schema([
                    table(
                        "users",
                        // Same columns, declared the other way round.
                        { zed: shapeB.zed, profile: shapeB.profile },
                        {
                            indexes: [
                                { fields: ["a"], name: "by_a" },
                                { fields: ["zed"], name: "by_zed" },
                            ],
                        },
                    ),
                ]),
                [],
            );

            expect(serializeSchemaSnapshot(first)).toBe(serializeSchemaSnapshot(second));
            expect(hashSchemaSnapshot(first)).toBe(hashSchemaSnapshot(second));
        });
    });
});
