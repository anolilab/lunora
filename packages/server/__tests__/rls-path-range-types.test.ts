import { describe, expect, it } from "vitest";

import { byId, MIX_QUERIES, MIX_ROWS } from "../../shard-engine/__tests__/_helpers/mixed-type-paths";
import { matchesWhere } from "../src/rls/where-match";

/**
 * A range over a path matches the leaves of the operand's own type, as the SQL stores do: a write gated in memory
 * must not allow what a read would hide. The dataset and the ids are the ones `@lunora/shard-engine`, `@lunora/sql-store`
 * and `@lunora/hyperdrive` assert against their SQL; JS would otherwise coerce `"30" > 5` to true.
 */
describe("a range over a path in the rls evaluator", () => {
    it.each(MIX_QUERIES)("finds %s", (_label, where, expected) => {
        expect.assertions(1);

        const ids = MIX_ROWS.filter(([, profile]) => matchesWhere({ profile }, where as never)).map(([id]) => id);

        expect(ids.toSorted(byId)).toStrictEqual(expected);
    });

    it("leaves a plain column compared as before", () => {
        expect.assertions(1);
        expect(matchesWhere({ mix: "50" }, { mix: { gt: 5 } })).toBe(true);
    });
});
