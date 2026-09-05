import { describe, expect, it } from "vitest";

import { definePolicies, definePolicy } from "../src/rls/define";
import { expectPolicy } from "../src/rls/testing";

/**
 * The JS `WhereInput` evaluator behind `rls()` must answer what the SQL compiler
 * (`@lunora/shard-engine`'s `where-sql.ts`) answers for the same predicate —
 * a read pushed down as SQL and a write gated in memory cannot disagree about
 * who is allowed.
 *
 * It diverged in two ways, both FAIL-OPEN on the write path, both pinned here.
 * The SQL column of each case was verified against SQLite over a table holding
 * `NULL`, `'admin'` and `'member'`:
 *
 * ```text
 * "role" <> 'admin'              -> ['member']              NULL excluded
 * "role" NOT IN ('admin','owner')-> ['member']              NULL excluded
 * "role" NOT IN ('admin', NULL)  -> []                      a NULL in the list excludes everything
 * empty NOT IN (compiles to 1=1) -> [NULL,'admin','member'] NULL included
 * ```
 *
 * A non-array `in`/`notIn` never reaches SQL at all: `compileInList` throws
 * `BAD_REQUEST` rather than dropping the restriction, because a scalar there
 * once compiled to `1 = 1`.
 *
 * `expectPolicy` runs the middleware's own primitives, so a read case exercises
 * `matchesWhere` through `computeReadBaseWhere` and a write case exercises it
 * through `evaluateWrite` — the same evaluator both callers share.
 */
describe("rls JS evaluator vs the SQL compiler's NULL semantics", () => {
    const readPolicy = (where: Record<string, unknown>) => definePolicies([definePolicy({ on: "read", table: "docs", when: () => where as never })]);

    const writePolicy = (where: Record<string, unknown>) => definePolicies([definePolicy({ on: "insert", table: "docs", when: () => where as never })]);

    it("denies a NULL cell against `ne` (SQL `<>` yields NULL, not true)", () => {
        expect.assertions(4);

        const write = expectPolicy(writePolicy({ role: { ne: "admin" } })).as({ userId: "ada" });

        expect(write.can("insert", "docs", { role: null })).toBe(false);
        // An absent column is the same missing value as a NULL cell.
        expect(write.can("insert", "docs", {})).toBe(false);
        expect(write.can("insert", "docs", { role: "member" })).toBe(true);

        const read = expectPolicy(readPolicy({ role: { ne: "admin" } })).as({ userId: "ada" });

        expect(read.can("read", "docs", { role: null })).toBe(false);
    });

    it("denies a NULL cell against a non-empty `notIn` (SQL `NOT IN` yields NULL)", () => {
        expect.assertions(3);

        const write = expectPolicy(writePolicy({ role: { notIn: ["admin", "owner"] } })).as({ userId: "ada" });

        expect(write.can("insert", "docs", { role: null })).toBe(false);
        expect(write.can("insert", "docs", {})).toBe(false);
        expect(write.can("insert", "docs", { role: "member" })).toBe(true);
    });

    it("denies every row when the `notIn` list itself holds a NULL", () => {
        expect.assertions(2);

        const write = expectPolicy(writePolicy({ role: { notIn: ["admin", null] } })).as({ userId: "ada" });

        expect(write.can("insert", "docs", { role: "member" })).toBe(false);
        expect(write.can("insert", "docs", { role: "admin" })).toBe(false);
    });

    it("admits a NULL cell against an EMPTY `notIn` (SQL compiles it to 1 = 1)", () => {
        expect.assertions(2);

        const write = expectPolicy(writePolicy({ role: { notIn: [] } })).as({ userId: "ada" });

        expect(write.can("insert", "docs", { role: null })).toBe(true);
        expect(write.can("insert", "docs", { role: "admin" })).toBe(true);
    });

    it("keeps `ne: null` equivalent to SQL `IS NOT NULL`", () => {
        expect.assertions(2);

        const write = expectPolicy(writePolicy({ role: { ne: null } })).as({ userId: "ada" });

        expect(write.can("insert", "docs", { role: "member" })).toBe(true);
        expect(write.can("insert", "docs", { role: null })).toBe(false);
    });

    it("throws on a scalar `notIn` instead of dropping the restriction", () => {
        expect.assertions(3);

        const write = expectPolicy(writePolicy({ role: { notIn: "admin" } })).as({ userId: "ada" });

        // The fail-open shape: a scalar `notIn` used to pass EVERY row, so an
        // `admin` row was admitted on write by a policy written to exclude it.
        expect(() => write.can("insert", "docs", { role: "admin" })).toThrow(/`notIn` on "role" expects an array/);

        const read = expectPolicy(readPolicy({ role: { notIn: "admin" } })).as({ userId: "ada" });

        expect(() => read.can("read", "docs", { role: "admin" })).toThrow(/`notIn` on "role" expects an array/);

        const nested = expectPolicy(writePolicy({ OR: [{ role: { notIn: "admin" } }] })).as({ userId: "ada" });

        expect(() => nested.can("insert", "docs", { role: "admin" })).toThrow(/`notIn` on "role" expects an array/);
    });

    it("throws on a scalar `in` instead of denying every row", () => {
        expect.assertions(1);

        const write = expectPolicy(writePolicy({ role: { in: "admin" } })).as({ userId: "ada" });

        expect(() => write.can("insert", "docs", { role: "admin" })).toThrow(/`in` on "role" expects an array/);
    });
});
