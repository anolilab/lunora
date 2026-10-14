import { describe, expect, it } from "vitest";

import type { SqlClient } from "../src";
import { projectSourceRow, pullSourceRows } from "../src";

/**
 * Read-side projection for the external-source ingest bridge (plan 077): external
 * rows → Lunora documents with `_id`, and the `pullSourceRows` query+project call.
 */

describe("projectSourceRow", () => {
    it("lifts the default `id` column to `_id` and drops it from the body", () => {
        expect.assertions(1);

        expect(projectSourceRow({ body: "hello", id: "d1", title: "Doc" })).toStrictEqual({ _id: "d1", body: "hello", title: "Doc" });
    });

    it("honours a custom id column", () => {
        expect.assertions(1);

        expect(projectSourceRow({ org_id: "o1", uuid: "abc" }, { idColumn: "uuid" })).toStrictEqual({ _id: "abc", org_id: "o1" });
    });

    it("stringifies a non-string id", () => {
        expect.assertions(1);

        expect(projectSourceRow({ id: 42, title: "Doc" })).toStrictEqual({ _id: "42", title: "Doc" });
    });

    it("uses `map` for the body and adds `_id` from the id column", () => {
        expect.assertions(1);

        const projected = projectSourceRow(
            { body: "drop", id: "d1", org_id: "o1", title: "Doc" },
            {
                map: (row) => {
                    return { orgId: row.org_id, title: row.title };
                },
            },
        );

        expect(projected).toStrictEqual({ _id: "d1", orgId: "o1", title: "Doc" });
    });

    it("throws when the id column is missing", () => {
        expect.assertions(1);

        expect(() => projectSourceRow({ title: "Doc" })).toThrow('missing id column "id"');
    });

    it("throws when the id column is null", () => {
        expect.assertions(1);

        expect(() => projectSourceRow({ id: null, title: "Doc" })).toThrow('missing id column "id"');
    });
});

describe("pullSourceRows", () => {
    it("runs the parameterised query and projects every row", async () => {
        expect.assertions(2);

        let calledWith: [string, ReadonlyArray<unknown> | undefined] | undefined;

        const query = (async (text: string, params?: ReadonlyArray<unknown>) => {
            calledWith = [text, params];

            return [
                { id: "d1", org_id: "o1", title: "One" },
                { id: "d2", org_id: "o1", title: "Two" },
            ];
        }) as SqlClient["query"];
        const sql: SqlClient = { query };

        const docs = await pullSourceRows(sql, {
            map: (row) => {
                return { orgId: row.org_id, title: row.title };
            },
            params: ["o1"],
            query: "SELECT id, title, org_id FROM documents WHERE org_id = $1",
        });

        expect(calledWith).toStrictEqual(["SELECT id, title, org_id FROM documents WHERE org_id = $1", ["o1"]]);
        expect(docs).toStrictEqual([
            { _id: "d1", orgId: "o1", title: "One" },
            { _id: "d2", orgId: "o1", title: "Two" },
        ]);
    });
});
