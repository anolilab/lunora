import { describe, expect, it } from "vitest";

import { sqlOperationName, sqlSystemOf } from "../src/sql-operation";

/**
 * The only two things `ctx.sql` telemetry reads off a client and its
 * statements. The operation must stay low-cardinality and must never carry
 * anything past the leading keyword.
 */

describe(sqlOperationName, () => {
    it.each([
        ["select * from orders where id = $1", "SELECT"],
        ["  INSERT INTO orders (id) VALUES ($1)", "INSERT"],
        ["\n\tupdate orders set total = 1", "UPDATE"],
        ["DELETE FROM orders", "DELETE"],
        ["-- fetch the slice\nSELECT 1", "SELECT"],
        ["/* drizzle */ select 1", "SELECT"],
        ["/* a */ -- b\n /* c */ (SELECT 1) UNION (SELECT 2)", "SELECT"],
        ["with recent as (select 1) select * from recent", "WITH"],
        ["begin", "BEGIN"],
        ["", "OTHER"],
        ["   ", "OTHER"],
        ["-- unterminated comment", "OTHER"],
        ["/* unterminated", "OTHER"],
        ["frobnicate the table", "OTHER"],
        ["SELECTED", "OTHER"],
        ["'; DROP TABLE users; --", "OTHER"],
    ])("reads %j as %s", (text, expected) => {
        expect.assertions(1);

        expect(sqlOperationName(text)).toBe(expected);
    });

    it("reports a non-string statement as OTHER", () => {
        expect.assertions(1);

        expect(sqlOperationName(42)).toBe("OTHER");
    });
});

describe(sqlSystemOf, () => {
    it.each([
        ["postgresql", "postgresql"],
        ["mysql", "mysql"],
        [undefined, "other_sql"],
    ])("reports an adapter stamp of %s as %s", (dbSystem, expected) => {
        expect.assertions(1);

        expect(sqlSystemOf(dbSystem)).toBe(expected);
    });
});
