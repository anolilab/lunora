import type { AdvisorCallSiteScope } from "./call-site-scope";

/**
 * One `ctx.db` write (`insert` / `replace` / `patch` / `insertManyUnsafe`) that
 * sets an ownership / identity column — `userId`, `ownerId`, `tenantId`, and the
 * like — from the handler's `args` instead of the server-trusted identity. This
 * is the `owner_field_from_args_not_auth` lint input: the ownership column decides
 * who a row belongs to, so a value taken from request input lets any caller write
 * rows owned by another user or tenant (the act-as-any-user / cross-tenant IDOR
 * vector). A column stamped from `ctx.auth` / `ctx.identity`, or set to a fixed
 * literal, is *not* recorded; only an arg-derived identity write reaches here.
 * Produced by the codegen feeder; runtime callers don't supply it, so the lint
 * finds nothing there. Structurally identical to `OwnerFieldWriteIR`.
 */
export interface AdvisorOwnerFieldWrite {
    /**
     * Every procedure that reaches the write is registered through an admin builder
     * (`adminMutation` / `adminAction` / `adminQuery`): the caller is a platform
     * admin by design, not an arbitrary user.
     */
    adminOnly?: true;
    /** The identity column being written from `args` (e.g. `userId`). */
    field: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;

    /**
     * The handler proves the written value equals the server identity before the
     * write (an `if (args.field !== identity) throw`, or an `assert*(…)` given both):
     * the value is validated, so the write is not reported. Mirrors the codegen
     * feeder's `guarded` stamp; see `isGuardedWrite` there.
     */
    guarded?: true;

    /** 1-based line of the `ctx.db` write call, or `0` when unknown. */
    line: number;

    /** The `ctx.db` write method (`insert` / `replace` / `patch` / `insertManyUnsafe`). */
    method: string;

    /**
     * The enclosing `defineMutator` declared this very column as its `owner`, AND
     * the value written resolves, by symbol, to that same `args[owner]` of the
     * `server` impl's own 2nd parameter. A nested closure's or a helper's own
     * `args` (or any binding shadowing it) never qualifies.
     *
     * `applyOwnerScope` requires a verified identity, rejects a client-supplied
     * value that disagrees with it, and overwrites the column with the verified
     * one before `server` runs — so on this exact shape `args[owner]` IS the
     * server identity, and it is what the docs prescribe. Recorded rather than
     * dropped at discovery: the write did happen, and the feeder is otherwise the
     * only place that knows. `owner_field_from_args_not_auth` is what declines to
     * report it.
     *
     * Deliberately NOT set when only the column NAME matches: `owner: "userId"`
     * launders `args.userId` and nothing else, so `{ userId: args.targetUserId }`
     * is a real IDOR and stays reportable.
     */
    ownerScoped?: true;

    /** Who the site runs on behalf of — see {@link AdvisorCallSiteScope}. */
    scope: AdvisorCallSiteScope;

    /**
     * Visibility of the enclosing procedure. `internal` procedures are not
     * reachable by a caller, so the "any caller can act as any user" premise
     * does not hold there and the finding drops to `INFO`. `undefined` when the
     * feeder could not attribute the write to a registered procedure.
     */
    visibility?: "internal" | "public";
}
