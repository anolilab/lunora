import { describe, expect, it } from "vitest";

import { definePolicies, definePolicy } from "../src/rls/define";
import { expectPolicy } from "../src/rls/testing";

/**
 * The JS `WhereInput` evaluator behind `rls()` (`src/rls/where-match.ts`) must
 * answer what the SQL compiler (`@lunora/shard-engine`'s `where-sql.ts`) answers
 * for the same predicate — a read pushed down as SQL and a write gated in memory
 * cannot disagree about who is allowed.
 *
 * **This table is the contract.** Every row was produced by compiling the
 * predicate with `compileWhereSql`, rendering it with `renderSql("sqlite", …)`
 * and running it on `node:sqlite` over a table holding `NULL`, `'admin'` and
 * `'member'` — never from memory. An absent column is the same missing value as
 * a NULL cell on the JS side (a document has no schema to be absent from).
 *
 * ```text
 * predicate                        rendered SQL                       rows
 * { role: { eq: "admin" } }        "role" = ?                         [admin]
 * { role: { eq: null } }           "role" IS NULL                     [NULL]
 * { role: { ne: "admin" } }        "role" <> ?                        [member]
 * { role: { ne: null } }           "role" IS NOT NULL                 [admin, member]
 * { NOT: { role: { ne: "admin" } } } NOT ("role" <> ?)                [admin]      <- NOT UNKNOWN is UNKNOWN
 * { role: { in: ["admin"] } }      "role" IN (?)                      [admin]
 * { role: { in: ["admin", null] } } "role" IN (?, ?)                  [admin]      <- NULL cell never matches IN
 * { NOT: { role: { in: ["admin", null] } } } NOT ("role" IN (?, ?))   []           <- a NULL member poisons the negation
 * { role: { in: [] } }             0 = 1                              []
 * { NOT: { role: { in: [] } } }    NOT (0 = 1)                        [NULL, admin, member]
 * { role: { notIn: ["admin"] } }   "role" NOT IN (?)                  [member]
 * { role: { notIn: ["admin", null] } } "role" NOT IN (?, ?)           []
 * { role: { notIn: [] } }          1 = 1                              [NULL, admin, member]
 * { NOT: { role: { notIn: [] } } } NOT (1 = 1)                        []
 * { role: { isNull: true } }       "role" IS NULL                     [NULL]
 * { NOT: { role: { isNull: true } } } NOT ("role" IS NULL)            [admin, member] <- IS NULL is total
 * { role: { contains: "adm" } }    instr(lower("role"), lower(?)) > 0 [admin]
 * { NOT: { role: { contains: "adm" } } } NOT (instr(…) > 0)           [member]
 * { role: { gt: "b" } }            "role" > ?                         [member]
 * { NOT: { role: { gt: "b" } } }   NOT ("role" > ?)                   [admin]
 * { role: { gt: null } }           0 = 1                              []
 * { NOT: { role: { gt: null } } }  NOT (0 = 1)                        [NULL, admin, member] <- a NULL OPERAND is FALSE
 * { NOT: { OR: [{ role: { eq: "admin" } }, { role: { ne: "admin" } }] } } … []
 * ```
 *
 * Two shapes never reach SQL at all, and are refused here for the same reason
 * the compiler refuses them: a non-array `in`/`notIn` (`compileInList` throws
 * `BAD_REQUEST` — a scalar once compiled to `1 = 1`), and an `undefined`
 * operand (`compileComparator` binds the placeholder anyway so the driver
 * rejects the statement, rather than folding it into `IS NULL`).
 *
 * `expectPolicy` runs the middleware's own primitives, so a read case exercises
 * `matchesWhere` through `computeReadBaseWhere` and a write case exercises it
 * through `evaluateWrite` — the same evaluator both callers share.
 */
describe("rls JS evaluator vs the SQL compiler's NULL semantics", () => {
    const readPolicy = (where: Record<string, unknown>) => definePolicies([definePolicy({ on: "read", table: "docs", when: () => where as never })]);

    const writePolicy = (where: Record<string, unknown>) => definePolicies([definePolicy({ on: "insert", table: "docs", when: () => where as never })]);

    const write = (where: Record<string, unknown>) => expectPolicy(writePolicy(where)).as({ userId: "ada" });

    const read = (where: Record<string, unknown>) => expectPolicy(readPolicy(where)).as({ userId: "ada" });

    it("denies a NULL cell against `ne` (SQL `<>` yields NULL, not true)", () => {
        expect.assertions(4);

        const gate = write({ role: { ne: "admin" } });

        expect(gate.can("insert", "docs", { role: null })).toBe(false);
        // An absent column is the same missing value as a NULL cell.
        expect(gate.can("insert", "docs", {})).toBe(false);
        expect(gate.can("insert", "docs", { role: "member" })).toBe(true);

        expect(read({ role: { ne: "admin" } }).can("read", "docs", { role: null })).toBe(false);
    });

    it("keeps a NULL cell excluded one `NOT` deep (`NOT UNKNOWN` is UNKNOWN, not true)", () => {
        expect.assertions(5);

        // The regression a boolean evaluator cannot express: the inner `ne`
        // answers UNKNOWN, `!false` turns that into an ADMITTED row, and this is
        // the write gate. SQL returns ['admin'] and so does this.
        const gate = write({ NOT: { role: { ne: "admin" } } });

        expect(gate.can("insert", "docs", { role: null })).toBe(false);
        expect(gate.can("insert", "docs", {})).toBe(false);
        expect(gate.can("insert", "docs", { role: "admin" })).toBe(true);
        expect(gate.can("insert", "docs", { role: "member" })).toBe(false);

        expect(read({ NOT: { role: { ne: "admin" } } }).can("read", "docs", { role: null })).toBe(false);
    });

    it("keeps UNKNOWN unknown through a doubled `NOT` and a negated group", () => {
        expect.assertions(4);

        expect(write({ NOT: { NOT: { role: { ne: "admin" } } } }).can("insert", "docs", { role: null })).toBe(false);
        expect(write({ NOT: { NOT: { role: { ne: "admin" } } } }).can("insert", "docs", { role: "member" })).toBe(true);

        // `NOT (role = 'admin' OR role <> 'admin')` returns nothing in SQL: the
        // two branches are UNKNOWN for a NULL cell and exhaustive for the rest.
        const negatedOr = write({ NOT: { OR: [{ role: { eq: "admin" } }, { role: { ne: "admin" } }] } });

        expect(negatedOr.can("insert", "docs", { role: null })).toBe(false);
        expect(negatedOr.can("insert", "docs", { role: "admin" })).toBe(false);
    });

    it("denies a NULL cell against `in`, whatever the list holds", () => {
        expect.assertions(6);

        // `NULL IN ('admin','member')` is UNKNOWN — a NULL cell is excluded by
        // IN unconditionally, and a NULL *in the list* does not rescue it.
        expect(write({ role: { in: ["admin", "member"] } }).can("insert", "docs", { role: null })).toBe(false);
        expect(write({ role: { in: ["admin", null] } }).can("insert", "docs", { role: null })).toBe(false);
        expect(write({ role: { in: ["admin", null] } }).can("insert", "docs", {})).toBe(false);
        // A non-member is UNKNOWN rather than false when the list carries a NULL.
        expect(write({ role: { in: ["admin", null] } }).can("insert", "docs", { role: "member" })).toBe(false);
        expect(write({ role: { in: ["admin", null] } }).can("insert", "docs", { role: "admin" })).toBe(true);

        expect(read({ role: { in: ["admin", null] } }).can("read", "docs", { role: null })).toBe(false);
    });

    it("negates `in` the way SQL does", () => {
        expect.assertions(4);

        expect(write({ NOT: { role: { in: ["admin"] } } }).can("insert", "docs", { role: "member" })).toBe(true);
        expect(write({ NOT: { role: { in: ["admin"] } } }).can("insert", "docs", { role: null })).toBe(false);
        // A NULL member makes every negated answer UNKNOWN.
        expect(write({ NOT: { role: { in: ["admin", null] } } }).can("insert", "docs", { role: "member" })).toBe(false);
        // An empty `in` is a literal FALSE, not UNKNOWN, so its negation admits everything.
        expect(write({ NOT: { role: { in: [] } } }).can("insert", "docs", { role: null })).toBe(true);
    });

    it("denies a NULL cell against a non-empty `notIn` (SQL `NOT IN` yields NULL)", () => {
        expect.assertions(3);

        const gate = write({ role: { notIn: ["admin", "owner"] } });

        expect(gate.can("insert", "docs", { role: null })).toBe(false);
        expect(gate.can("insert", "docs", {})).toBe(false);
        expect(gate.can("insert", "docs", { role: "member" })).toBe(true);
    });

    it("denies every row when the `notIn` list itself holds a NULL", () => {
        expect.assertions(2);

        const gate = write({ role: { notIn: ["admin", null] } });

        expect(gate.can("insert", "docs", { role: "member" })).toBe(false);
        expect(gate.can("insert", "docs", { role: "admin" })).toBe(false);
    });

    it("admits a NULL cell against an EMPTY `notIn` (SQL compiles it to 1 = 1)", () => {
        expect.assertions(3);

        const gate = write({ role: { notIn: [] } });

        expect(gate.can("insert", "docs", { role: null })).toBe(true);
        expect(gate.can("insert", "docs", { role: "admin" })).toBe(true);
        // …and `NOT (1 = 1)` denies every row, NULL included.
        expect(write({ NOT: { role: { notIn: [] } } }).can("insert", "docs", { role: null })).toBe(false);
    });

    it("keeps `ne: null` equivalent to SQL `IS NOT NULL`", () => {
        expect.assertions(2);

        const gate = write({ role: { ne: null } });

        expect(gate.can("insert", "docs", { role: "member" })).toBe(true);
        expect(gate.can("insert", "docs", { role: null })).toBe(false);
    });

    it("treats `isNull` as total — never UNKNOWN, so `NOT` flips it cleanly", () => {
        expect.assertions(3);

        expect(write({ role: { isNull: true } }).can("insert", "docs", {})).toBe(true);
        expect(write({ NOT: { role: { isNull: true } } }).can("insert", "docs", { role: null })).toBe(false);
        expect(write({ NOT: { role: { isNull: true } } }).can("insert", "docs", { role: "admin" })).toBe(true);
    });

    it("excludes a NULL cell from `contains`, negated or not", () => {
        expect.assertions(3);

        expect(write({ role: { contains: "adm" } }).can("insert", "docs", { role: null })).toBe(false);
        expect(write({ NOT: { role: { contains: "adm" } } }).can("insert", "docs", { role: null })).toBe(false);
        expect(write({ NOT: { role: { contains: "adm" } } }).can("insert", "docs", { role: "member" })).toBe(true);
    });

    it("splits the ordered comparators the way the compiler does: NULL cell UNKNOWN, NULL operand FALSE", () => {
        expect.assertions(4);

        expect(write({ role: { gt: "b" } }).can("insert", "docs", { role: null })).toBe(false);
        // UNKNOWN survives the negation…
        expect(write({ NOT: { role: { gt: "b" } } }).can("insert", "docs", { role: null })).toBe(false);
        // …but a NULL OPERAND compiles to a literal `0 = 1`, which is FALSE, so
        // its negation admits every row including the NULL one.
        expect(write({ role: { gt: null } }).can("insert", "docs", { role: "admin" })).toBe(false);
        expect(write({ NOT: { role: { gt: null } } }).can("insert", "docs", { role: null })).toBe(true);
    });

    it("throws on a scalar `notIn` instead of dropping the restriction", () => {
        expect.assertions(3);

        // The fail-open shape: a scalar `notIn` used to pass EVERY row, so an
        // `admin` row was admitted on write by a policy written to exclude it.
        expect(() => write({ role: { notIn: "admin" } }).can("insert", "docs", { role: "admin" })).toThrow(/`notIn` on "role" expects an array/);

        expect(() => read({ role: { notIn: "admin" } }).can("read", "docs", { role: "admin" })).toThrow(/`notIn` on "role" expects an array/);

        expect(() => write({ OR: [{ role: { notIn: "admin" } }] }).can("insert", "docs", { role: "admin" })).toThrow(/`notIn` on "role" expects an array/);
    });

    it("throws on a scalar `in` instead of denying every row", () => {
        expect.assertions(1);

        expect(() => write({ role: { in: "admin" } }).can("insert", "docs", { role: "admin" })).toThrow(/`in` on "role" expects an array/);
    });

    it("throws on an `undefined` operand instead of matching every absent cell", () => {
        expect.assertions(5);

        // `{ ownerId: undefined }` is a dropped variable. SQL binds the
        // placeholder anyway and the driver rejects the statement; this used to
        // compare with `!==` and silently match every row without the column.
        expect(() => write({ ownerId: undefined }).can("insert", "docs", {})).toThrow(/`eq` on "ownerId" received undefined/);
        expect(() => write({ ownerId: { eq: undefined } }).can("insert", "docs", {})).toThrow(/`eq` on "ownerId" received undefined/);
        expect(() => write({ ownerId: { ne: undefined } }).can("insert", "docs", {})).toThrow(/`ne` on "ownerId" received undefined/);
        expect(() => write({ ownerId: { gt: undefined } }).can("insert", "docs", {})).toThrow(/`gt` on "ownerId" received undefined/);
        // …including one hidden inside an `in` list, where drizzle drops the
        // bind and `NOT IN ()` would otherwise match every row.
        expect(() => write({ ownerId: { in: ["ada", undefined] } }).can("insert", "docs", {})).toThrow(/`in` on "ownerId" received undefined inside its list/);
    });

    it("reads an absent column as SQL NULL in the equality shorthand", () => {
        expect.assertions(2);

        // `{ role: null }` compiles to `role IS NULL`, which a document without
        // the column satisfies — a strict `!== null` said otherwise.
        expect(write({ role: null }).can("insert", "docs", {})).toBe(true);
        expect(write({ role: null }).can("insert", "docs", { role: "admin" })).toBe(false);
    });
});
