import { describe, expect, it } from "vitest";

import { isRelationPredicate, RELATION_OPERATOR_KEYS, RELATION_OPERATOR_SET } from "../../../shared/relation-operators";

/**
 * The relation operator names are shared source (`shared/relation-operators.ts`)
 * rather than a per-package literal, because three call sites need them and two
 * of them are security guards in a package that cannot depend on this one.
 *
 * The consequences of a divergence are not symmetric. The engine's compiler
 * throws on an operator it does not know, which is loud. `@lunora/server`'s mask
 * where-scope guard uses the same predicate to decide whether to DESCEND into a
 * node — so a name it does not know is a node it walks straight past, which
 * reopens the value oracle that guard exists to close. Silently, on the new
 * operator only, with every existing test still green.
 *
 * Both directions of engine/shared agreement are enforced by the compiler, not
 * here: `RELATION_OPERATOR_META` is typed `Record<RelationOperator, …>`, which
 * admits neither a missing row nor an extra one. What needs a test is the shape
 * rule itself, since that is what the two server guards branch on.
 */
describe("shared relation operators", () => {
    it("recognises every shared name as a relation node", () => {
        // One per operator; five today, and the loop below asserts each.
        expect.assertions(5);

        // The mask and RLS guards descend on exactly this answer. A name in the
        // set that the predicate rejects is a node those guards walk past.
        for (const key of RELATION_OPERATOR_KEYS) {
            expect(isRelationPredicate({ [key]: { ownerId: { eq: "u1" } } })).toBe(true);
        }
    });

    it("leaves an ordinary filter on a relation-named column alone", () => {
        expect.assertions(3);

        // "All keys known" is the disambiguation: a column legitimately called
        // `is` or `some` holding a column filter is NOT a relation node, and
        // treating it as one would rewrite a user's filter into a join.
        expect(isRelationPredicate({ eq: "yes" })).toBe(false);
        expect(isRelationPredicate({ is: { eq: "x" }, notAnOperator: 1 })).toBe(false);
        expect(isRelationPredicate({})).toBe(false);
    });

    it("rejects the non-object shapes a where tree can hold", () => {
        expect.assertions(4);

        expect(isRelationPredicate(null)).toBe(false);
        expect(isRelationPredicate(undefined)).toBe(false);
        expect(isRelationPredicate([{ is: {} }])).toBe(false);
        expect(isRelationPredicate("some")).toBe(false);
    });

    it("keeps the set and the key list in agreement", () => {
        expect.assertions(2);

        expect(RELATION_OPERATOR_SET.size).toBe(RELATION_OPERATOR_KEYS.length);
        expect(RELATION_OPERATOR_KEYS.every((key) => RELATION_OPERATOR_SET.has(key))).toBe(true);
    });
});
