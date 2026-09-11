import { LunoraError } from "lunorash/errors";
import type { Middleware } from "lunorash/server";
import { definePolicies, definePolicy, rls } from "lunorash/server";

import type { ActionCtx, MutationCtx, QueryCtx } from "#lunora/_generated/server.js";

/**
 * The builder's one ownership model — plan 335 §D6's "a project belongs to an
 * account", enforced rather than assumed.
 *
 * **`projects` is the ownership record, and RLS is what guards it.** The three
 * policies below are the isolation boundary for the `.global()` `projects`
 * table: a read is narrowed to the caller's own rows, an insert must name the
 * caller as owner, and an update must be against a row the caller already owns.
 * An anonymous caller decides `false` on all three, so the table fails CLOSED —
 * the same secure-by-default posture `.rls("required")` takes, expressed with
 * the framework's own primitive instead of an `if (ctx.auth…)` restated in every
 * handler.
 *
 * **Everything per-project is authorized through the project, not by its own
 * policy.** `chats`, `messages` and `files` `.shardBy("projectId")`, and their
 * tenancy IS that project id. An RLS policy cannot express "the project this
 * row's `projectId` points at is mine": `definePolicy`'s `when` is a pure
 * SYNCHRONOUS predicate with no database access, and `projects` lives in a
 * different storage tier (D1) from its sharded children. So the cross-tier half
 * of the rule is {@link authorizeProject} — one helper, called before any read
 * or write that accepts a `projectId`, which resolves the CANONICAL project row
 * and compares its owner against the verified caller.
 *
 * That is also why the shard key is never taken on trust: every public
 * per-project procedure passes the caller's `projectId` through
 * {@link authorizeProject} and uses the value it returns. A forged id is a 404
 * before it can route a single read at a shard.
 *
 * Internal functions (the agent's `ls`/`view`/`write`/`edit`/`exec` tools) are
 * deliberately NOT guarded here. They are unreachable as public RPC, and the
 * durable agent loop dispatches with no identity — an owner check there would
 * deny the agent its own project. Their trust boundary is the dispatch: the
 * `projectId` a run works on comes from {@link authorizeProject} in the mutation
 * that started it.
 */
const policies = definePolicies([
    definePolicy({ on: "read", table: "projects", when: ({ auth }) => (auth.userId === null ? false : { ownerId: auth.userId }) }),
    definePolicy({ on: "insert", table: "projects", when: ({ auth, row }) => auth.userId !== null && row?.["ownerId"] === auth.userId }),
    definePolicy({ on: "update", table: "projects", when: ({ auth, row }) => auth.userId !== null && row?.["ownerId"] === auth.userId }),
]);

/**
 * `rls()` types its context against the runtime writer shape
 * (`RlsContextIn.db: DatabaseWriterLike`), which the generated reader/writer
 * facades deliberately narrow — the runtime object underneath is the same
 * adapter, so re-typing the middleware onto the generated ctx is sound. Same
 * boundary cast `apps/playground/lunora/notes.ts` uses.
 */
const projectsReadRls = rls(policies) as unknown as Middleware<QueryCtx, QueryCtx>;

/** The write-path twin of {@link projectsReadRls}. */
const projectsWriteRls = rls(policies) as unknown as Middleware<MutationCtx, MutationCtx>;

/** The slice of a context the ownership checks read — any of the three procedure kinds satisfies it. */
type OwnerContext = ActionCtx | MutationCtx | QueryCtx;

/**
 * The verified caller id, or a 401.
 *
 * Returning it (rather than a boolean) is what makes an ownership column a
 * server-trusted column: the only value a handler can stamp into `ownerId` is
 * the one this function hands back, never something off `args`.
 */
const requireOwner = (ctx: { auth: { userId: null | string } }): string => {
    const { userId } = ctx.auth;

    if (userId === null) {
        throw new LunoraError("UNAUTHORIZED", "Sign in to use the builder");
    }

    return userId;
};

/**
 * Resolve a caller-supplied `projectId` against the canonical project row and
 * prove the caller owns it. Returns the trusted id to route by.
 *
 * A missing project and a project owned by somebody else both answer 404 rather
 * than 403: telling an attacker "that id exists, but it isn't yours" turns the
 * dashboard's id space into an enumeration oracle.
 */
const authorizeProject = async (ctx: OwnerContext, projectId: string): Promise<{ ownerId: string; projectId: string }> => {
    const ownerId = requireOwner(ctx);

    const project = await ctx.db.get(ctx.db.asId("projects", projectId));

    if (project?.ownerId !== ownerId) {
        throw new LunoraError("NOT_FOUND", "No such project");
    }

    return { ownerId, projectId };
};

export { authorizeProject, policies, projectsReadRls, projectsWriteRls, requireOwner };
