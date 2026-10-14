/**
 * The two extreme {@link WhereInput} predicates, named.
 *
 * Both are trivial to write by hand and one of them is dangerous to get wrong,
 * which is the whole reason they're named here. A shape's (or policy's) `where`
 * returns a *predicate*, not a boolean, so "deny everything" has to be expressed
 * as a predicate that matches no rows — the vacuously-false `{ OR: [] }`. The
 * plausible-looking `{}` is the exact opposite: it matches every row, so a denial
 * branch that returns `{}` silently replicates the whole table. There is no error,
 * no log line, and the shape still "works".
 *
 * So: `deny()` and `allowAll()`, and never the literals at a call site.
 */

import type { WhereInput } from "./types";

/**
 * A predicate matching **no** rows — the deny decision.
 *
 * `{ OR: [] }` is a disjunction over zero branches, which the where-compiler
 * folds to a constant false. Use it (never a bare `{}`) for the unauthorized
 * branch of a shape or policy predicate:
 *
 * ```ts
 * where: (ctx, { userId }) => (ctx.auth.userId === userId ? { userId } : deny())
 * ```
 *
 * A fresh object per call, so a caller can safely spread or extend the result.
 */
const deny = (): WhereInput => {
    return { OR: [] };
};

/**
 * A predicate matching **every** row — no restriction beyond whatever it is
 * AND-composed with. The honest spelling of "this branch adds no filter", where a
 * bare `{}` reads like an oversight.
 */
const allowAll = (): WhereInput => {
    return {};
};

/**
 * `true` when `where` is the vacuously-false deny predicate — i.e. an `OR` over
 * zero branches, carrying no other constraint. Used by the runtime to short-circuit
 * a denied read instead of compiling and running SQL that provably matches nothing.
 */
const isDeny = (where: WhereInput): boolean => Array.isArray(where.OR) && where.OR.length === 0 && Object.keys(where).length === 1;

/**
 * Normalize a boolean-or-predicate decision to a {@link WhereInput}.
 *
 * The authoring surfaces accept `true`/`false` as sugar — they read far better
 * than the sentinel objects in an ownership check — and every consumer downstream
 * wants a plain predicate. `undefined` means "no opinion" and maps to
 * {@link allowAll}, matching the RLS `PolicyDecision` contract.
 */
const toWhereInput = (decision: WhereInput | boolean | undefined): WhereInput => {
    if (decision === true || decision === undefined) {
        return allowAll();
    }

    if (decision === false) {
        return deny();
    }

    return decision;
};

export { allowAll, deny, isDeny, toWhereInput };
