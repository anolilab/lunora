import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor, R2SqlResult } from "../src/index";
import { desc, fn, SelectBuilder, sql } from "../src/index";

const noopExec: QueryExecutor = async () => {
    return { columns: [], rowCount: 0, rows: [] };
};

const from = (table: string) => new SelectBuilder(noopExec, table);

describe("select builder SQL", () => {
    it("defaults to SELECT *", () => {
        expect(from("s.orders").toSQL()).toBe("SELECT * FROM s.orders");
    });

    it("renders an explicit column list", () => {
        expect(from("s.orders").select("a", "b").toSQL()).toBe("SELECT a, b FROM s.orders");
    });

    it("renders DISTINCT and DISTINCT ON", () => {
        expect(from("s.orders").select("region").distinct().toSQL()).toBe("SELECT DISTINCT region FROM s.orders");
        expect(from("s.orders").distinctOn("region").select("region", "id").orderBy("region", desc("total")).toSQL()).toBe(
            "SELECT DISTINCT ON (region) region, id FROM s.orders ORDER BY region, total DESC",
        );
    });

    it("combines multiple where conditions with AND", () => {
        expect(
            from("s.orders")
                .where(sql`region = ${"North"}`)
                .where("total > 0", sql`status = ${200}`)
                .toSQL(),
        ).toBe("SELECT * FROM s.orders WHERE region = 'North' AND total > 0 AND status = 200");
    });

    it("renders joins", () => {
        expect(
            from("s.zones z")
                .select("z.domain", "h.method")
                .innerJoin("s.http h", "z.zone_id = h.zone_id")
                .leftJoin("s.fw f", sql`z.zone_id = f.zone_id`)
                .toSQL(),
        ).toBe("SELECT z.domain, h.method FROM s.zones z INNER JOIN s.http h ON z.zone_id = h.zone_id LEFT JOIN s.fw f ON z.zone_id = f.zone_id");
    });

    it("cross join has no ON", () => {
        expect(from("a").crossJoin("b").toSQL()).toBe("SELECT * FROM a CROSS JOIN b");
    });

    it("group by + having", () => {
        expect(from("s.orders").select("region", "COUNT(*) AS n").groupBy("region").having("COUNT(*) > 1000").toSQL()).toBe(
            "SELECT region, COUNT(*) AS n FROM s.orders GROUP BY region HAVING COUNT(*) > 1000",
        );
    });

    it("qualify with a window function", () => {
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
        expect(
            from("s.orders")
                .select("id", fn.rowNumber().over({ partitionBy: "region" }).as("rk"))
                .toSQL(),
        ).toBe("SELECT id, ROW_NUMBER() OVER (PARTITION BY region) AS rk FROM s.orders");
    });

    it("order by + limit, inlining the limit", () => {
        expect(from("s.orders").orderBy(desc("total")).limit(50).toSQL()).toBe("SELECT * FROM s.orders ORDER BY total DESC LIMIT 50");
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
        expect(a().union(b()).toSQL()).toBe("SELECT zone_id FROM s.fw WHERE action = 'block' UNION SELECT zone_id FROM s.zones WHERE plan = 'enterprise'");
        expect(a().intersect(b()).toSQL()).toContain("INTERSECT");
        expect(a().except(b()).toSQL()).toContain("EXCEPT");
        expect(a().unionAll(b()).toSQL()).toContain("UNION ALL");
    });

    it("parenthesises a member that carries its own ORDER BY / LIMIT", () => {
        const limited = from("s.fw").select("zone_id").limit(10);

        expect(limited.union(b()).toSQL()).toBe("(SELECT zone_id FROM s.fw LIMIT 10) UNION SELECT zone_id FROM s.zones WHERE plan = 'enterprise'");
    });

    it("applies a trailing ORDER BY / LIMIT to the combined result", () => {
        expect(a().union(b()).orderBy("zone_id").limit(100).toSQL()).toMatch(
            /UNION SELECT zone_id FROM s\.zones WHERE plan = 'enterprise' ORDER BY zone_id LIMIT 100$/,
        );
    });

    it("chains a third set operation", () => {
        expect(a().union(b()).except(from("s.archived").select("zone_id")).toSQL()).toContain(
            "UNION SELECT zone_id FROM s.zones WHERE plan = 'enterprise' EXCEPT SELECT zone_id FROM s.archived",
        );
    });
});

describe("run", () => {
    it("passes the rendered SQL to the executor and returns its result", async () => {
        const result: R2SqlResult = { columns: [{ name: "id" }], rowCount: 1, rows: [{ id: "x" }] };
        const exec = vi.fn<QueryExecutor>(async () => result);
        const builder = new SelectBuilder(exec, "s.orders");

        const out = await builder.select("id").limit(5).run();

        expect(exec).toHaveBeenCalledWith("SELECT id FROM s.orders LIMIT 5");
        expect(out).toBe(result);
    });
});
