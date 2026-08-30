/**
 * Carry the RLS + mask policy tags of an inner middleware chain onto the single
 * middleware a composer returns.
 *
 * `rls()` and `mask()` stamp their policy tag on the middleware FUNCTION object
 * (a non-enumerable, `Symbol.for`-keyed property — see `rls/policy-tag.ts`), and
 * the builder hoists them by reading those tags off the DIRECT elements of the
 * `.use(...)` chain (`collectRls` / `collectMask`). A composer that folds N
 * middlewares into one fresh arrow therefore drops every tag it wrapped unless
 * it re-stamps — which is what this does.
 *
 * A dropped tag is silent and security-relevant. Without `fn.rls` the table gets
 * no group in `buildRlsReadRegistry`, `resolveReadBaseWhere` answers `undefined`
 * ("unrestricted") for every table that is not `.rls("required")`, and a
 * `defineShape` over it replicates every row to every client — even though the
 * procedure it was attached to enforces the policy correctly at request time.
 */
import { readMaskTag, tagMaskMiddleware } from "./mask/policy-tag";
import { readRlsTags, tagRlsMiddleware } from "./rls/policy-tag";

/**
 * Re-stamp the union of `chain`'s policy tags onto `composed`, returning the
 * same reference.
 *
 * RLS tags stay a LIST (one entry per `rls()` step): a policy's `auth.can(...)`
 * must resolve against the role→permission map of the middleware that declared
 * it, so flattening would let one step's permission satisfy another's policy.
 * Mask tags carry only column NAMES — no role-scoped decision — so they union
 * into one tag, exactly as `collectMask` already flattens them per function.
 */
const carryPolicyTags = <M extends object>(composed: M, chain: ReadonlyArray<unknown>): M => {
    const rlsTags = chain.flatMap((middleware) => readRlsTags(middleware));

    if (rlsTags.length > 0) {
        tagRlsMiddleware(composed, rlsTags);
    }

    const columns = new Map<string, Set<string>>();

    for (const middleware of chain) {
        const tag = readMaskTag(middleware);

        if (!tag) {
            continue;
        }

        for (const [table, tableColumns] of tag.columns) {
            const set = columns.get(table) ?? new Set<string>();

            for (const column of tableColumns) {
                set.add(column);
            }

            columns.set(table, set);
        }
    }

    if (columns.size > 0) {
        tagMaskMiddleware(composed, { columns });
    }

    return composed;
};

export default carryPolicyTags;
