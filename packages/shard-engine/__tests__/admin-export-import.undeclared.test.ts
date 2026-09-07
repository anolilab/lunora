import { describe, expect, it } from "vitest";

import { validateImportRow } from "../src/admin-export-import";
import type { SchemaLike } from "../src/ctx-db";

/**
 * A snapshot line naming a field the table does not declare is refused, so it
 * cannot reach the writer unvalidated.
 *
 * The membership test is `Object.hasOwn`, not `key in shape`: `in` walks the
 * prototype chain, so `constructor`, `toString` and `__proto__` reported
 * themselves declared on any table and were imported without validation.
 */
const schema: SchemaLike = {
    tables: {
        events: {
            indexes: [],
            shape: { kind: { kind: "string" } },
        },
    },
};

describe("shard admin import — undeclared fields", () => {
    it("refuses a field the table does not declare", () => {
        expect.assertions(1);

        expect(validateImportRow(schema, "events", { _id: "e1", kind: "a", title: "gone" })).toBe('unexpected field "title": not declared in table "events"');
    });

    it.each(["constructor", "toString", "__proto__"])("refuses the inherited Object key %s", (key) => {
        expect.assertions(1);

        expect(validateImportRow(schema, "events", { _id: "e1", kind: "a", [key]: "surprise" })).toBe(
            `unexpected field "${key}": not declared in table "events"`,
        );
    });
});
