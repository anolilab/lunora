/**
 * A `where` / `orderBy` naming a field the schema does not declare, on the
 * SQLite that reads an unresolved double-quoted name as a string literal.
 *
 * `findMany` compiles its keys with no `definition.shape` lookup (see
 * `jsonPathSql` in `src/do-sql.ts`), so a procedure that spreads an argument
 * into `where` reaches SQL with a name off the wire. The engine does not reject
 * it: every user field becomes `json_extract(__doc__, '$.<field>')`, a path into
 * the document that is NULL when the key is absent. That is the property under
 * test. Were a user field ever spliced as a bare `"field"` identifier instead,
 * `node:sqlite` (`SQLITE_DQS=0`) would raise "no such column" and the node
 * suites would stay green over it — while on workerd `"ghost" = 'ghost'` is
 * TRUE for every row and the read returns the whole table.
 */
import { aroundEach, describe, expect, it } from "vitest";

import type { SqlExec } from "../../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../../src/ctx-db";
import messagesSchema from "../_helpers/messages-schema";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);

const setup = async (): Promise<{ statements: string[]; writer: ReturnType<typeof createShardContextDatabase> }> => {
    const { sql } = createWorkerdExec();
    const statements: string[] = [];
    const recording: SqlExec = {
        exec: (query: string, ...params: unknown[]) => {
            statements.push(query);

            return sql.exec(query, ...params);
        },
    };

    runShardMigrations(sql, messagesSchema);

    const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, schema: messagesSchema, sql: recording });

    for (const text of ["a", "b", "c"]) {
        // eslint-disable-next-line no-await-in-loop -- three seed rows, inserted in order
        await writer.insert("messages", { authorId: "u1", channelId: "c1", text });
    }

    statements.length = 0;

    return { statements, writer };
};

describe("an undeclared field on workerd SQLite", () => {
    it("still reads a bare double-quoted unknown name as a string literal (the hazard is live)", () => {
        expect.assertions(1);

        // If workerd ever builds with SQLITE_DQS=0 this fails, and the rest of the
        // file stops proving anything the node suites do not — say so loudly.
        const { raw } = createWorkerdExec();

        expect(raw(`SELECT "ghost" AS v`)).toStrictEqual([{ v: "ghost" }]);
    });

    it("matches nothing on a `where` equality, instead of every row", async () => {
        expect.assertions(3);

        const { statements, writer } = await setup();
        const result = await writer.findMany("messages", { where: { ghost: "ghost" } });

        expect(result.page).toStrictEqual([]);

        const read = statements.find((statement) => statement.includes("'$.ghost'")) ?? "";

        expect(read).toContain(`json_extract(__doc__, '$.ghost')`);
        expect(read).not.toContain(`"ghost"`);
    });

    it("matches nothing for a name carrying a double quote, and does not throw", async () => {
        expect.assertions(2);

        const { statements, writer } = await setup();
        const result = await writer.findMany("messages", { where: { 'gh"ost': 'gh"ost' } });

        expect(result.page).toStrictEqual([]);
        expect(statements.some((statement) => statement.includes("json_extract(__doc__, '$."))).toBe(true);
    });

    it("orders by an unknown field as an all-NULL key, keeping every row", async () => {
        expect.assertions(2);

        const { statements, writer } = await setup();
        const result = await writer.findMany("messages", { orderBy: [{ ghost: "asc" }] });

        expect(result.page.map((row) => String(row["text"])).toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["a", "b", "c"]);
        expect(statements.find((statement) => statement.includes("ORDER BY"))).toContain(`json_extract(__doc__, '$.ghost')`);
    });
});
