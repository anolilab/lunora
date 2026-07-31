import { describe, expect, it } from "vitest";

import { diffSchemaSnapshots, SCHEMA_SNAPSHOT_VERSION, serializeSchemaSnapshot } from "../../../shared/schema-snapshot";
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
            expect(snapshot.tables.users?.fields.nickname).toStrictEqual({ kind: "string", optional: true });
            expect(snapshot.tables.users?.fields.name).toStrictEqual({ kind: "string", optional: false });
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
                { scope: "table", severity: "safe", summary: "added optional field users.bio", table: "users", type: "addedOptionalField" },
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
                { scope: "table", severity: "safe", summary: "field users.name became optional", table: "users", type: "fieldRequiredToOptional" },
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
            const decision = evaluateSchemaDrift({ baseline, current });

            expect(decision.blocked).toBe(false);
            expect(decision.reason).toContain("additive/safe");
        });

        it("blocks breaking drift when no new migration was added", () => {
            expect.assertions(3);

            const current = buildSchemaSnapshot(schema([table("users", { name: numberField })]), []);
            const decision = evaluateSchemaDrift({ baseline, current });

            expect(decision.blocked).toBe(true);
            expect(decision.reason).toContain("deploy blocked");
            expect(decision.reason).toContain("changed type");
        });

        it("passes breaking drift when a NEW migration id is present", () => {
            expect.assertions(3);

            const current = buildSchemaSnapshot(schema([table("users", { name: numberField })]), ["fix-name-type"]);
            const decision = evaluateSchemaDrift({ baseline, current });

            expect(decision.blocked).toBe(false);
            expect(decision.newMigrationIds).toStrictEqual(["fix-name-type"]);
            expect(decision.reason).toContain("new migration(s) were added");
        });

        it("passes breaking drift when overridden with allowDrift", () => {
            expect.assertions(2);

            const current = buildSchemaSnapshot(schema([table("users", { name: numberField })]), []);
            const decision = evaluateSchemaDrift({ allowDrift: true, baseline, current });

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

                const { reason } = evaluateSchemaDrift({ baseline, command: "deploy", current: breaking() });

                expect(reason).toContain("--allow-schema-drift");
                expect(reason).toContain("--update-schema-baseline");
            });

            it("offers only --allow-schema-drift on verify, and points at prepare for the other", () => {
                expect.assertions(3);

                const { reason } = evaluateSchemaDrift({ baseline, command: "verify", current: breaking() });

                expect(reason).toContain("pass `--allow-schema-drift`");
                expect(reason).toContain("lunora prepare --update-schema-baseline");
                expect(reason).toContain("`lunora verify` does not take that flag");
            });

            it("names prepare on build, which accepts neither flag", () => {
                expect.assertions(2);

                const { reason } = evaluateSchemaDrift({ baseline, command: "build", current: breaking() });

                expect(reason).toContain("`lunora build` has no override flag");
                expect(reason).toContain("lunora prepare --allow-schema-drift");
            });

            it("falls back to listing both when the caller is unknown", () => {
                expect.assertions(2);

                const { reason } = evaluateSchemaDrift({ baseline, current: breaking() });

                expect(reason).toContain("--allow-schema-drift");
                expect(reason).toContain("--update-schema-baseline");
            });
        });

        it("never blocks a first-ever capture (no baseline)", () => {
            expect.assertions(1);

            const current = buildSchemaSnapshot(schema([table("users", { name: stringField })]), []);
            const decision = evaluateSchemaDrift({ baseline: undefined, current });

            expect(decision.blocked).toBe(false);
        });

        it("a re-added migration id (already in baseline) does not satisfy the gate", () => {
            expect.assertions(1);

            const withMigration = buildSchemaSnapshot(schema([table("users", { name: stringField })]), ["m1"]);
            // breaking change but the only migration id is the same one the baseline already knew.
            const current = buildSchemaSnapshot(schema([table("users", { name: numberField })]), ["m1"]);
            const decision = evaluateSchemaDrift({ baseline: withMigration, current });

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
});
