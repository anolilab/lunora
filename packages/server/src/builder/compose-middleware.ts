import { tagMaskMiddleware, unionMaskColumns } from "../mask/policy-tag";
import { readRlsTags, tagRlsMiddleware } from "../rls/policy-tag";
import runMiddlewareChain from "./run-middleware";
import type { Middleware, MiddlewareNext } from "./types";

/**
 * Fold a chain of middlewares into ONE `.use()`-able middleware, carrying the
 * chain's policy tags onto the result.
 *
 * The composing and the tagging are one operation on purpose. `rls()` and
 * `mask()` stamp their policy on the middleware FUNCTION object (a
 * non-enumerable, `Symbol.for`-keyed property — see `rls/policy-tag.ts`), and
 * the builder hoists them by reading those tags off the DIRECT elements of the
 * `.use(...)` chain. A composer that returns a fresh arrow therefore drops every
 * tag it wrapped, and a dropped tag is silent and security-relevant: without
 * `fn.rls` the table gets no group in `buildRlsReadRegistry`,
 * `resolveReadBaseWhere` answers `undefined` ("unrestricted") for every table
 * that is not `.rls("required")`, and a `defineShape` over it replicates every
 * row to every client — even though the procedure the middleware was attached to
 * still enforces the policy correctly at request time.
 *
 * Every composer in the package (`protectPublic`, `composePluginMiddleware`,
 * and whatever is added next) routes through here so re-stamping cannot be
 * forgotten.
 *
 * RLS tags stay a LIST (one entry per `rls()` step): a policy's `auth.can(...)`
 * must resolve against the role→permission map of the middleware that declared
 * it, so flattening would let one step's permission satisfy another's policy.
 * Mask tags carry only column NAMES — no role-scoped decision — so they union
 * into one tag via the shared {@link unionMaskColumns}.
 *
 * The context types are free variables the caller pins: the executor threads the
 * accumulated context through untouched, so what each composer promises about
 * the shape it hands to the surrounding `next` is the composer's own contract,
 * not something this seam can check.
 */
const composeMiddleware = <ContextIn, ContextOut>(chain: ReadonlyArray<Middleware<unknown, unknown>>): Middleware<ContextIn, ContextOut> => {
    // The terminal hands the fully accumulated context to the surrounding
    // builder's own `next`, making the composed unit transparent — behaviourally
    // identical to chaining the same middlewares with N `.use()` calls, down to
    // the shared double-`next()` guard in `runMiddlewareChain`.
    const composed = (async ({ ctx, next }) =>
        runMiddlewareChain(chain, ctx, (context) => (next as MiddlewareNext<unknown>)({ ctx: context as Record<string, unknown> }))) as Middleware<
        ContextIn,
        ContextOut
    >;

    const rlsTags = chain.flatMap((middleware) => readRlsTags(middleware));

    if (rlsTags.length > 0) {
        tagRlsMiddleware(composed, rlsTags);
    }

    const columns = unionMaskColumns(chain);

    if (columns) {
        tagMaskMiddleware(composed, { columns });
    }

    return composed;
};

export default composeMiddleware;
