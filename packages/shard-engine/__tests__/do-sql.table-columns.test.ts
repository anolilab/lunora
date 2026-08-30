import { describe, expect, it } from "vitest";

import { tableColumns } from "../src/do-sql";
import type { TableDefinitionLike } from "../src/schema-types";

/** A two-column table, one of which carries no `.column()` meta and so is skipped. */
const definition = (): TableDefinitionLike => {
    return {
        indexes: [],
        shape: {
            name: { _meta: { column: { defaultValue: "anon" } }, kind: "string" },
            note: { kind: "string" },
            seq: { _meta: { column: { defaultValue: 0 } }, kind: "number" },
        },
    };
};

describe("tableColumns", () => {
    it("returns only fields carrying column meta", () => {
        expect.assertions(1);

        expect(tableColumns(definition()).map(([field]) => field)).toStrictEqual(["name", "seq"]);
    });

    it("memoizes per definition object", () => {
        expect.assertions(2);

        const table = definition();

        expect(tableColumns(table)).toBe(tableColumns(table));
        expect(tableColumns(definition())).not.toBe(tableColumns(table));
    });

    // The memo is shared across every write on the table, so a caller mutating what
    // it hands back would poison `applyInsertDefaults`/`applyOnUpdate` for all later
    // rows — silently, as defaults that stop applying. Both levels are frozen so the
    // mutation throws instead.
    it("freezes the array and every pair in it", () => {
        expect.assertions(3);

        const columns = tableColumns(definition());

        expect(Object.isFrozen(columns)).toBe(true);
        expect(() => (columns as unknown as unknown[]).push(["evil", {}])).toThrow(TypeError);
        expect(() => {
            (columns[0] as unknown as unknown[])[1] = {};
        }).toThrow(TypeError);
    });
});
