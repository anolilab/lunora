import { LunoraError } from "lunorash/server";

import type { Id } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

interface DocumentRow {
    _id: Id<"documents">;
    organizationId: string;
    ownerId: string;
    title: string;
    body: string;
    createdAt: number;
}

/**
 * Identity gate. `ctx.auth.userId` is populated by Lunora's runtime from the
 * resolved session — see `src/server/index.ts` for how the auth instance is
 * wired in. It is the only caller-identifying value on a procedure context that
 * the client cannot forge.
 */
const assertSignedIn = (userId: null | string): string => {
    if (!userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    return userId;
};

/**
 * What isolates these documents, and what does not.
 *
 * `ownerId` is stamped from the session on `create` and required to match on
 * every read, so a caller only ever sees their own rows. `organizationId` is
 * NOT a trust boundary here: it arrives in `args`, so a caller can file a
 * document under any org id they like — it is a label on their own documents,
 * not a claim the server verified.
 *
 * Gating on *membership* needs the inbound `Headers`, because better-auth
 * authorizes `getActiveMember` from the caller's session cookie. A Lunora
 * procedure context deliberately carries only the resolved identity, so a
 * `query`/`mutation` cannot make that call — compose `withAuthPlugins(auth)`
 * onto an `httpAction`, which does have the request, and check
 * `ctx.authApi.getActiveMember({ headers: request.headers, query: {
 * organizationId } })` there before trusting the org id. A production app wants
 * that check in addition to the owner scoping below.
 */
export const list = query.input({ organizationId: v.string().max(128) }).query(async ({ args: { organizationId }, ctx }): Promise<DocumentRow[]> => {
    const userId = assertSignedIn(ctx.auth.userId);

    // The equality prefix pins the row set to this caller's own documents; the
    // index's trailing `createdAt` supplies the ordering, so nothing is sorted
    // (or over-read) in JS.
    return ctx.db
        .query("documents")
        .withIndex("by_org_owner_created", (range) => range.eq("organizationId", organizationId).eq("ownerId", userId))
        .order("desc")
        .collect();
});

/** File a new document. `ownerId` comes from the session, never from `args`. */
export const create = mutation
    .input({
        organizationId: v.string().max(128),
        title: v.string().max(256),
        body: v.string().max(100_000),
    })
    .mutation(async ({ args: { organizationId, title, body }, ctx }): Promise<Id<"documents">> => {
        const userId = assertSignedIn(ctx.auth.userId);

        return ctx.db.insert("documents", {
            organizationId,
            ownerId: userId,
            title,
            body,
            createdAt: Date.now(),
        });
    });
