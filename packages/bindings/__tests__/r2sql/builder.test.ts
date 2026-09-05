import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor, R2SqlResult } from "../../src/r2sql/index";
import { desc, fn, SelectBuilder, sql } from "../../src/r2sql/index";

const noopExec: QueryExecutor = async () => {
    return { columns: [], rowCount: 0, rows: [] };
};

const from = (table: string) => new SelectBuilder(noopExec, table);

describe("select builder SQL", () => {
    it("defaults to SELECT *", () => {
        expect.assertions(1);

        expect(from("s.orders").toSQL()).toBe("SELECT * FROM s.orders");
    });

    it("renders an explicit column list", () => {
        expect.assertions(1);

        expect(from("s.orders").select("a", "b").toSQL()).toBe("SELECT a, b FROM s.orders");
    });

    it("renders DISTINCT and DISTINCT ON", () => {
        expect.assertions(2);

        expect(from("s.orders").select("region").distinct().toSQL()).toBe("SELECT DISTINCT region FROM s.orders");
        expect(from("s.orders").distinctOn("region").select("region", "id").orderBy("region", desc("total")).toSQL()).toBe(
            "SELECT DISTINCT ON (region) region, id FROM s.orders ORDER BY region, total DESC",
        );
    });

    it("combines multiple where conditions with AND", () => {
        expect.assertions(1);

        expect(
            from("s.orders")
                .where(sql`region = ${"North"}`)
                .where("total > 0", sql`status = ${200}`)
                .toSQL(),
        ).toBe("SELECT * FROM s.orders WHERE (region = 'North') AND (total > 0) AND (status = 200)");
    });

    it("parenthesises each condition so a fragment carrying OR still binds as one conjunct", () => {
        expect.assertions(2);

        // `AND` binds tighter than `OR`, so joining raw fragments with a bare
        // ` AND ` re-parses `a OR b` + `c` as `a OR (b AND c)` — a filter that
        // matches rows the caller excluded. Every in-repo caller happens to pass
        // `=`/`IN`/`LIKE`, which is why it stayed latent on the public
        // `ctx.r2sql` surface.
        expect(from("s.orders").where("region = 'N' OR region = 'S'").where("total > 0").toSQL()).toBe(
            "SELECT * FROM s.orders WHERE (region = 'N' OR region = 'S') AND (total > 0)",
        );

        expect(
            from("s.orders").select("region", "COUNT(*) AS n").groupBy("region").having("COUNT(*) > 10 OR SUM(total) > 100").having("COUNT(*) < 1000").toSQL(),
        ).toBe("SELECT region, COUNT(*) AS n FROM s.orders GROUP BY region HAVING (COUNT(*) > 10 OR SUM(total) > 100) AND (COUNT(*) < 1000)");
    });

    it("renders joins", () => {
        expect.assertions(1);

        expect(
            from("s.zones z")
                .select("z.domain", "h.method")
                .innerJoin("s.http h", "z.zone_id = h.zone_id")
                .leftJoin("s.fw f", sql`z.zone_id = f.zone_id`)
                .toSQL(),
        ).toBe("SELECT z.domain, h.method FROM s.zones z INNER JOIN s.http h ON z.zone_id = h.zone_id LEFT JOIN s.fw f ON z.zone_id = f.zone_id");
    });

    it("cross join has no ON", () => {
        expect.assertions(1);

        expect(from("a").crossJoin("b").toSQL()).toBe("SELECT * FROM a CROSS JOIN b");
    });

    it("renders right and full outer joins", () => {
        expect.assertions(2);

        expect(from("a").rightJoin("b", "a.id = b.id").toSQL()).toBe("SELECT * FROM a RIGHT JOIN b ON a.id = b.id");
        expect(from("a").fullJoin("b", "a.id = b.id").toSQL()).toBe("SELECT * FROM a FULL OUTER JOIN b ON a.id = b.id");
    });

    it("returns() re-types without changing the SQL", () => {
        expect.assertions(1);

        const typed = from("s.orders").select("id").returns<{ id: string }>();

        expect(typed.toSQL()).toBe("SELECT id FROM s.orders");
    });

    it("group by + having", () => {
        expect.assertions(1);

        expect(from("s.orders").select("region", "COUNT(*) AS n").groupBy("region").having("COUNT(*) > 1000").toSQL()).toBe(
            "SELECT region, COUNT(*) AS n FROM s.orders GROUP BY region HAVING COUNT(*) > 1000",
        );
    });

    it("qualify with a window function", () => {
        expect.assertions(1);

        expect(
            from("s.orders")
                .select("customer_id")
                .qualify(
                    fn
                        .rowNumber()
                        .over({ orderBy: desc("total"), partitionBy: "region" })
                        .lte(3),
                )
                .toSQL(),
        ).toBe("SELECT customer_id FROM s.orders QUALIFY ROW_NUMBER() OVER (PARTITION BY region ORDER BY total DESC) <= 3");
    });

    it("aliases a window expression into the select list", () => {
        expect.assertions(1);

        expect(
            from("s.orders")
                .select("id", fn.rowNumber().over({ partitionBy: "region" }).as("rk"))
                .toSQL(),
        ).toBe("SELECT id, ROW_NUMBER() OVER (PARTITION BY region) AS rk FROM s.orders");
    });

    it("order by + limit, inlining the limit", () => {
        expect.assertions(1);

        expect(from("s.orders").orderBy(desc("total")).limit(50).toSQL()).toBe("SELECT * FROM s.orders ORDER BY total DESC LIMIT 50");
    });

    it("rejects a non-integer / non-positive / over-ceiling limit eagerly (R2 SQL: 1–10,000)", () => {
        expect.assertions(4);

        // Previously stored unvalidated, rendering `LIMIT 3.5` / `LIMIT 0` /
        // `LIMIT 50000` that R2 SQL rejects as an opaque remote error.
        expect(() => from("s.orders").limit(3.5)).toThrow(/between 1 and 10000/);
        expect(() => from("s.orders").limit(0)).toThrow(RangeError);
        expect(() => from("s.orders").limit(-1)).toThrow(RangeError);
        expect(() => from("s.orders").limit(50_000)).toThrow(/between 1 and 10000/);
    });

    it("rejects an unsafe table identifier spliced into FROM (no injection)", () => {
        expect.assertions(2);

        // R2 SQL has no parameter binding, so the table name is spliced into the
        // statement — a non-identifier must be refused at construction, not rendered.
        expect(() => from("s.orders; DROP TABLE users")).toThrow(/invalid table reference/u);
        expect(() => from("s.orders WHERE 1=1")).toThrow(/invalid table reference/u);
    });

    it("rejects an unsafe join identifier (no injection through JOIN)", () => {
        expect.assertions(2);

        expect(() => from("s.orders").innerJoin("evil; DROP TABLE users", "a = b")).toThrow(/invalid table reference/u);
        expect(() => from("s.orders").crossJoin("a) UNION SELECT secret FROM x --")).toThrow(/invalid table reference/u);
    });
});

describe("set operations", () => {
    const a = () =>
        from("s.fw")
            .select("zone_id")
            .where(sql`action = ${"block"}`);
    const b = () =>
        from("s.zones")
            .select("zone_id")
            .where(sql`plan = ${"enterprise"}`);

    it("renders UNION, INTERSECT, EXCEPT", () => {
        expect.assertions(4);

        expect(a().union(b()).toSQL()).toBe("SELECT zone_id FROM s.fw WHERE action = 'block' UNION SELECT zone_id FROM s.zones WHERE plan = 'enterprise'");
        expect(a().intersect(b()).toSQL()).toContain("INTERSECT");
        expect(a().except(b()).toSQL()).toContain("EXCEPT");
        expect(a().unionAll(b()).toSQL()).toContain("UNION ALL");
    });

    it("parenthesises a member that carries its own ORDER BY / LIMIT", () => {
        expect.assertions(1);

        const limited = from("s.fw").select("zone_id").limit(10);

        expect(limited.union(b()).toSQL()).toBe("(SELECT zone_id FROM s.fw LIMIT 10) UNION SELECT zone_id FROM s.zones WHERE plan = 'enterprise'");
    });

    it("applies a trailing ORDER BY / LIMIT to the combined result", () => {
        expect.assertions(1);

        expect(a().union(b()).orderBy("zone_id").limit(100).toSQL()).toMatch(
            /UNION SELECT zone_id FROM s\.zones WHERE plan = 'enterprise' ORDER BY zone_id LIMIT 100$/,
        );
    });

    it("validates a set-operation limit with the same 1–10,000 rule", () => {
        expect.assertions(2);

        expect(() => a().union(b()).limit(0)).toThrow(/between 1 and 10000/);
        expect(() => a().union(b()).limit(3.5)).toThrow(RangeError);
    });

    it("chains a third set operation", () => {
        expect.assertions(1);

        expect(a().union(b()).except(from("s.archived").select("zone_id")).toSQL()).toContain(
            "UNION SELECT zone_id FROM s.zones WHERE plan = 'enterprise' EXCEPT SELECT zone_id FROM s.archived",
        );
    });

    it("parenthesises a nested set operation so mixed operators don't mis-associate", () => {
        expect.assertions(1);

        // a.union(b.except(c)) must render `a UNION (b EXCEPT c)`, not the flat
        // `a UNION b EXCEPT c` which left-associates to `(a UNION b) EXCEPT c`.
        expect(
            a()
                .union(b().except(from("s.archived").select("zone_id")))
                .toSQL(),
        ).toBe(
            "SELECT zone_id FROM s.fw WHERE action = 'block' UNION (SELECT zone_id FROM s.zones WHERE plan = 'enterprise' EXCEPT SELECT zone_id FROM s.archived)",
        );
    });

    it("appends every operator when chaining on an existing set operation", () => {
        expect.assertions(3);

        const base = () => a().union(b());

        expect(base().unionAll(from("s.x").select("zone_id")).toSQL()).toContain("UNION ALL SELECT zone_id FROM s.x");
        expect(base().intersect(from("s.x").select("zone_id")).toSQL()).toContain("INTERSECT SELECT zone_id FROM s.x");
        expect(base().union(from("s.x").select("zone_id")).toSQL()).toContain("UNION SELECT zone_id FROM s.x");
    });

    it("returns() re-types a set operation without changing the SQL", () => {
        expect.assertions(1);

        const typed = a().union(b()).returns<{ zone_id: string }>();

        expect(typed.toSQL()).toBe("SELECT zone_id FROM s.fw WHERE action = 'block' UNION SELECT zone_id FROM s.zones WHERE plan = 'enterprise'");
    });
});

describe("run", () => {
    it("passes the rendered SQL to the executor and returns its result", async () => {
        expect.assertions(2);

        const result: R2SqlResult = { columns: [{ name: "id" }], rowCount: 1, rows: [{ id: "x" }] };
        const exec = vi.fn<QueryExecutor>(async () => result);
        const builder = new SelectBuilder(exec, "s.orders");

        const out = await builder.select("id").limit(5).run();

        expect(exec).toHaveBeenCalledWith("SELECT id FROM s.orders LIMIT 5");
        expect(out).toBe(result);
    });
});
