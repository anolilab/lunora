import { describe, expect, it } from "vitest";

import type { SchemaSnapshot, TableSnapshot } from "../../../../../shared/schema-snapshot";
import { serializeSchemaSnapshot } from "../../../../../shared/schema-snapshot";
import { buildSchemaDiffModel, snapshotFromJson } from "../../../src/features/database/schema-diff-model";

const table = (overrides: Partial<TableSnapshot> = {}): TableSnapshot => {
    return {
        fields: { id: { kind: "id", optional: false } },
        indexes: {},
        relations: {},
        shardMode: "root",
        ...overrides,
    };
};

const snapshot = (tables: Record<string, TableSnapshot>): SchemaSnapshot => {
    return { migrationIds: [], tables, version: 1 };
};

const statusOf = (model: ReturnType<typeof buildSchemaDiffModel>, name: string): string | undefined =>
    model.tables.find((entry) => entry.name === name)?.status;

describe("buildSchemaDiffModel", () => {
    it("treats every table as added when there is no previous version", () => {
        expect.assertions(2);

        const model = buildSchemaDiffModel(undefined, snapshot({ users: table() }));

        expect(statusOf(model, "users")).toBe("added");
        // A first capture is never drift, so nothing is breaking.
        expect(model.breakingCount).toBe(0);
    });

    it("marks a table whose own field changed as changed, and leaves neighbours as context", () => {
        expect.assertions(2);

        const before = snapshot({ posts: table(), users: table() });
        const after = snapshot({
            posts: table(),
            users: table({ fields: { id: { kind: "id", optional: false }, name: { kind: "string", optional: true } } }),
        });
        const model = buildSchemaDiffModel(before, after);

        expect(statusOf(model, "users")).toBe("changed");
        expect(statusOf(model, "posts")).toBe("context");
    });

    it("keeps a table unchanged when only a relation on the OTHER side moved", () => {
        expect.assertions(2);

        // The amber signal must stay synonymous with "this table's own shape
        // moved" — a back-relation added on `users` is not a change to `posts`.
        const before = snapshot({ posts: table(), users: table() });
        const after = snapshot({
            posts: table(),
            users: table({ relations: { posts: { field: "authorId", kind: "many", table: "posts" } } }),
        });
        const model = buildSchemaDiffModel(before, after);

        expect(statusOf(model, "users")).toBe("context");
        expect(statusOf(model, "posts")).toBe("context");
    });

    it("renders a removed table from its last known shape", () => {
        expect.assertions(3);

        const model = buildSchemaDiffModel(snapshot({ legacy: table(), users: table() }), snapshot({ users: table() }));

        expect(statusOf(model, "legacy")).toBe("removed");
        // Its columns still render — otherwise the most consequential change in a
        // migration would be the one thing the canvas cannot show.
        expect(model.tables.find((entry) => entry.name === "legacy")?.columns).toHaveLength(1);
        expect(model.breakingCount).toBeGreaterThan(0);
    });

    it("labels per-field status for the row glyphs", () => {
        expect.assertions(3);

        const before = snapshot({ users: table({ fields: { id: { kind: "id", optional: false }, old: { kind: "string", optional: false } } }) });
        const after = snapshot({
            users: table({ fields: { id: { kind: "id", optional: false }, added: { kind: "string", optional: true } } }),
        });
        const fieldStatus = buildSchemaDiffModel(before, after).tables.find((entry) => entry.name === "users")?.fieldStatus ?? {};

        expect(fieldStatus.added).toBe("added");
        expect(fieldStatus.old).toBe("removed");
        expect(fieldStatus.id).toBe("unchanged");
    });

    it("flags a field whose kind changed", () => {
        expect.assertions(2);

        const before = snapshot({ users: table({ fields: { age: { kind: "string", optional: false } } }) });
        const after = snapshot({ users: table({ fields: { age: { kind: "number", optional: false } } }) });
        const model = buildSchemaDiffModel(before, after);

        expect(model.tables.find((entry) => entry.name === "users")?.fieldStatus.age).toBe("changed");
        // A type change needs a data migration — the gate's verdict, shown verbatim.
        expect(model.breakingCount).toBe(1);
    });

    it("resolves a foreign key by its column, not its accessor name", () => {
        expect.assertions(1);

        const model = buildSchemaDiffModel(
            undefined,
            snapshot({
                posts: table({
                    fields: { authorId: { kind: "id", optional: false } },
                    // Accessor `author` ≠ column `authorId`: keying on the accessor
                    // would silently drop every FK arrow from the canvas.
                    relations: { author: { field: "authorId", kind: "one", table: "users" } },
                }),
            }),
        );

        expect(model.tables[0]?.columns.find((column) => column.name === "authorId")?.ref).toBe("users");
    });
});

describe("snapshotFromJson", () => {
    it("round-trips a serialized snapshot", () => {
        expect.assertions(1);

        const original = snapshot({ users: table() });

        expect(snapshotFromJson(serializeSchemaSnapshot(original))?.tables.users?.shardMode).toBe("root");
    });

    it("returns undefined for absent or corrupt JSON rather than throwing", () => {
        expect.assertions(3);

        // The Studio renders an unreadable ledger row as an empty state; only the
        // CLI gate treats a malformed snapshot as fatal.
        expect(snapshotFromJson(undefined)).toBeUndefined();
        expect(snapshotFromJson("not json")).toBeUndefined();
        expect(snapshotFromJson('{"version":99,"tables":{}}')).toBeUndefined();
    });
});
