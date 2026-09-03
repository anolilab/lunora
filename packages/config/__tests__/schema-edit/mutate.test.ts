import { describe, expect, it } from "vitest";

import type { ApplyEditResult } from "../../src/schema-edit/mutate";
import { applyAdditiveEdit, classifyEdit } from "../../src/schema-edit/mutate";
import { parseSchema } from "../../src/schema-edit/parse";

const SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

// Keep this comment intact across edits.
export default defineSchema({
    todos: defineTable({
        text: v.string(),
        done: v.boolean(),
    }).index("by_text", ["text"]),
});
`;

/** Narrow an apply result to its text, failing the test if it did not apply. */
const textOf = (result: ApplyEditResult): string => {
    if (!result.ok) {
        throw new Error(`expected ok apply, got ${result.reason}`);
    }

    return result.text;
};

/** The failure reason of a result, or `undefined` when it applied. */
const reasonOf = (result: ApplyEditResult): string | undefined => (result.ok ? undefined : result.reason);

describe("classifyEdit", () => {
    it("labels additive edits additive", () => {
        expect.assertions(3);

        expect(classifyEdit({ kind: "addTable", table: "x" })).toBe("additive");
        expect(classifyEdit({ column: "y", kind: "addOptionalColumn", table: "x", validator: "v.string()" })).toBe("additive");
        expect(classifyEdit({ fields: ["y"], kind: "addIndex", name: "by_y", table: "x" })).toBe("additive");
    });

    it("labels rename/drop/type-change/required destructive", () => {
        expect.assertions(5);

        expect(classifyEdit({ column: "y", kind: "renameColumn", newName: "z", table: "x" })).toBe("destructive");
        expect(classifyEdit({ column: "y", kind: "dropColumn", table: "x" })).toBe("destructive");
        expect(classifyEdit({ kind: "dropTable", table: "x" })).toBe("destructive");
        expect(classifyEdit({ column: "y", kind: "changeColumnType", table: "x", validator: "v.number()" })).toBe("destructive");
        expect(classifyEdit({ column: "y", kind: "makeRequired", table: "x" })).toBe("destructive");
    });
});

describe("applyAdditiveEdit", () => {
    it("adds a table, preserving the leading comment", () => {
        expect.assertions(2);

        const text = textOf(applyAdditiveEdit(SCHEMA, { kind: "addTable", table: "notes" }));
        const parsed = parseSchema(text);

        expect(text).toContain("Keep this comment intact across edits.");
        expect(parsed.ok && parsed.tables.some((table) => table.name === "notes")).toBe(true);
    });

    it("adds an optional column wrapped in v.optional", () => {
        expect.assertions(1);

        const parsed = parseSchema(textOf(applyAdditiveEdit(SCHEMA, { column: "due", kind: "addOptionalColumn", table: "todos", validator: "v.number()" })));
        const due = parsed.ok ? parsed.tables.find((table) => table.name === "todos")?.columns.find((column) => column.name === "due") : undefined;

        expect(due).toStrictEqual({ name: "due", optional: true, validator: "v.optional(v.number())" });
    });

    it("appends an index to the existing chain", () => {
        expect.assertions(1);

        const parsed = parseSchema(textOf(applyAdditiveEdit(SCHEMA, { fields: ["done"], kind: "addIndex", name: "by_done", table: "todos", unique: true })));
        const indexes = parsed.ok ? parsed.tables.find((table) => table.name === "todos")?.indexes : undefined;

        expect(indexes).toStrictEqual([
            { fields: ["text"], name: "by_text", unique: false },
            { fields: ["done"], name: "by_done", unique: true },
        ]);
    });

    it("keeps the existing columns when adding one to a chain-less table", () => {
        expect.assertions(1);

        // A `defineTable({ … })` with no chain is the initializer node itself, so
        // a descendants-only lookup found no shape and rewrote the table empty.
        const chainless = `import { defineSchema, defineTable, v } from "@lunora/server";\n\nexport default defineSchema({\n    todos: defineTable({\n        text: v.string(),\n        done: v.boolean(),\n    }),\n});\n`;
        const text = textOf(applyAdditiveEdit(chainless, { column: "due", kind: "addOptionalColumn", table: "todos", validator: "v.number()" }));
        const parsed = parseSchema(text);

        expect(parsed.ok ? parsed.tables[0]?.columns.map((column) => column.name) : undefined).toStrictEqual(["text", "done", "due"]);
    });

    it("refuses destructive edits without touching the source", () => {
        expect.assertions(1);

        expect(applyAdditiveEdit(SCHEMA, { column: "text", kind: "dropColumn", table: "todos" })).toStrictEqual({ ok: false, reason: "destructive" });
    });

    it("reports duplicate-table / duplicate-column / duplicate-index / unknown-table", () => {
        expect.assertions(4);

        expect(reasonOf(applyAdditiveEdit(SCHEMA, { kind: "addTable", table: "todos" }))).toBe("duplicate-table");
        expect(reasonOf(applyAdditiveEdit(SCHEMA, { column: "text", kind: "addOptionalColumn", table: "todos", validator: "v.string()" }))).toBe(
            "duplicate-column",
        );
        expect(reasonOf(applyAdditiveEdit(SCHEMA, { fields: ["text"], kind: "addIndex", name: "by_text", table: "todos" }))).toBe("duplicate-index");
        expect(reasonOf(applyAdditiveEdit(SCHEMA, { column: "x", kind: "addOptionalColumn", table: "ghost", validator: "v.string()" }))).toBe("unknown-table");
    });

    it("marks a new table .global() with the requested backend", () => {
        expect.assertions(2);

        const text = textOf(applyAdditiveEdit(SCHEMA, { global: { backend: "hyperdrive" }, kind: "addTable", table: "invoices" }));

        expect(text).toContain('.global({ backend: "hyperdrive" })');
        // And the parser reads it back — `.global({ … })` used to look non-global.
        expect(parseSchema(text)).toMatchObject({ tables: expect.arrayContaining([expect.objectContaining({ global: true, name: "invoices" })]) });
    });

    it("emits a bare .global() when no backend is named", () => {
        expect.assertions(1);

        expect(textOf(applyAdditiveEdit(SCHEMA, { global: {}, kind: "addTable", table: "invoices" }))).toContain(".global()");
    });

    it("refuses a backend outside the allow-list", () => {
        expect.assertions(1);

        expect(reasonOf(applyAdditiveEdit(SCHEMA, { global: { backend: "sqlite" as never }, kind: "addTable", table: "invoices" }))).toBe("invalid-identifier");
    });

    it("rejects a validator that is not a v.* expression (code injection)", () => {
        expect.assertions(3);

        // The classic CSRF payload: a comma expression that runs arbitrary code
        // before yielding a real validator.
        expect(
            reasonOf(
                applyAdditiveEdit(SCHEMA, {
                    column: "x",
                    kind: "addOptionalColumn",
                    table: "todos",
                    validator: "(globalThis.__p=process,v.string())",
                }),
            ),
        ).toBe("invalid-validator");
        expect(reasonOf(applyAdditiveEdit(SCHEMA, { column: "x", kind: "addOptionalColumn", table: "todos", validator: "evil()" }))).toBe("invalid-validator");
        // A smuggled second statement must not slip past on the structural check.
        expect(reasonOf(applyAdditiveEdit(SCHEMA, { column: "x", kind: "addOptionalColumn", table: "todos", validator: "v.string()); evil((" }))).toBe(
            "invalid-validator",
        );
    });

    it("accepts nested v.* validators (array / object / union)", () => {
        expect.assertions(1);

        expect(applyAdditiveEdit(SCHEMA, { column: "meta", kind: "addOptionalColumn", table: "todos", validator: "v.object({ a: v.string() })" }).ok).toBe(
            true,
        );
    });

    it("rejects non-identifier table / column / index names", () => {
        expect.assertions(3);

        expect(reasonOf(applyAdditiveEdit(SCHEMA, { kind: "addTable", table: "bad-name" }))).toBe("invalid-identifier");
        expect(reasonOf(applyAdditiveEdit(SCHEMA, { column: "a b", kind: "addOptionalColumn", table: "todos", validator: "v.string()" }))).toBe(
            "invalid-identifier",
        );
        expect(reasonOf(applyAdditiveEdit(SCHEMA, { fields: ["text"], kind: "addIndex", name: "by text", table: "todos" }))).toBe("invalid-identifier");
    });

    it("reports aliased-define-schema rather than rewriting an aliased import", () => {
        expect.assertions(1);

        const aliased = `import { defineSchema as ds, defineTable, v } from "@lunora/server";\nexport default ds({ a: defineTable({ x: v.string() }) });\n`;

        expect(reasonOf(applyAdditiveEdit(aliased, { kind: "addTable", table: "b" }))).toBe("aliased-define-schema");
    });
});
