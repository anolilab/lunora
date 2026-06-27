import { describe, expect, it } from "vitest";

import { asc, desc, fn, renderOrderTerm } from "../../src/r2sql/index";

describe("order terms", () => {
    it("asc / desc tag a term with a direction", () => {
        expect(renderOrderTerm(asc("total"))).toBe("total ASC");
        expect(renderOrderTerm(desc("total"))).toBe("total DESC");
    });

    it("a bare string is left as-is (ASC by default)", () => {
        expect(renderOrderTerm("total")).toBe("total");
    });
});

describe("window functions", () => {
    it("builds ROW_NUMBER with partition and order", () => {
        const expr = fn.rowNumber().over({ orderBy: desc("total_amount"), partitionBy: "region" });

        expect(expr.text).toBe("ROW_NUMBER() OVER (PARTITION BY region ORDER BY total_amount DESC)");
    });

    it("multiple partitions and orders", () => {
        const expr = fn.rank().over({ orderBy: [desc("a"), asc("b")], partitionBy: ["region", "dept"] });

        expect(expr.text).toBe("RANK() OVER (PARTITION BY region, dept ORDER BY a DESC, b ASC)");
    });

    it("aggregate window with an explicit frame", () => {
        const expr = fn.sum("total_amount").over({ frame: "ROWS BETWEEN 2 PRECEDING AND CURRENT ROW", orderBy: "total_amount" });

        expect(expr.text).toBe("SUM(total_amount) OVER (ORDER BY total_amount ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)");
    });

    it("defaults COUNT() to COUNT(*)", () => {
        expect(fn.count().over().text).toBe("COUNT(*) OVER ()");
        expect(fn.count("id").over().text).toBe("COUNT(id) OVER ()");
    });

    it("renders LAG with offset and default", () => {
        expect(fn.lag("total", 1, 0).over({ orderBy: "total" }).text).toBe("LAG(total, 1, 0) OVER (ORDER BY total)");
    });

    it("inlines NTILE and NTH_VALUE numeric args", () => {
        expect(fn.ntile(4).over().text).toBe("NTILE(4) OVER ()");
        expect(fn.nthValue("total", 2).over().text).toBe("NTH_VALUE(total, 2) OVER ()");
    });

    it("renders every ranking, offset and aggregate helper", () => {
        // Ranking helpers that take no args.
        expect(fn.denseRank().over().text).toBe("DENSE_RANK() OVER ()");
        expect(fn.percentRank().over().text).toBe("PERCENT_RANK() OVER ()");
        expect(fn.cumeDist().over().text).toBe("CUME_DIST() OVER ()");
        // Offset/value helpers that take a column.
        expect(fn.lead("total").over().text).toBe("LEAD(total) OVER ()");
        expect(fn.firstValue("total").over().text).toBe("FIRST_VALUE(total) OVER ()");
        expect(fn.lastValue("total").over().text).toBe("LAST_VALUE(total) OVER ()");
        // Aggregate-as-window helpers.
        expect(fn.avg("total").over().text).toBe("AVG(total) OVER ()");
        expect(fn.min("total").over().text).toBe("MIN(total) OVER ()");
        expect(fn.max("total").over().text).toBe("MAX(total) OVER ()");
    });
});

describe("window expression → select / qualify", () => {
    it("as() aliases the expression", () => {
        expect(fn.rowNumber().over({ partitionBy: "region" }).as("rk").text).toBe("ROW_NUMBER() OVER (PARTITION BY region) AS rk");
    });

    it("as() rejects a non-identifier alias", () => {
        expect(() => fn.rowNumber().over().as("rk; DROP")).toThrow(/invalid identifier/);
    });

    it("comparison helpers build QUALIFY conditions", () => {
        const window = fn.rowNumber().over({ orderBy: desc("total"), partitionBy: "region" });

        expect(window.lte(3).text).toBe("ROW_NUMBER() OVER (PARTITION BY region ORDER BY total DESC) <= 3");
        expect(window.eq(1).text).toBe("ROW_NUMBER() OVER (PARTITION BY region ORDER BY total DESC) = 1");
        expect(fn.rank().over().between(1, 5).text).toBe("RANK() OVER () BETWEEN 1 AND 5");
    });

    it("covers every comparison operator", () => {
        const rank = fn.rank().over();

        expect(rank.gt(1).text).toBe("RANK() OVER () > 1");
        expect(rank.gte(2).text).toBe("RANK() OVER () >= 2");
        expect(rank.lt(3).text).toBe("RANK() OVER () < 3");
    });
});
