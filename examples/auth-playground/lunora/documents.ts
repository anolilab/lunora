import { LunoraError } from "@lunora/server";

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
 * Lightweight identity gate. `ctx.auth.userId` is populated by Lunora's
 * runtime from the resolved session — see `src/server/index.ts` for how the
 * auth instance is wired in.
 *
 * For the *full* org-membership check, queries should compose
 * `withAuthPlugins(auth)` and call `ctx.authApi.getActiveMember({ headers,
 * query: { organizationId } })` — the addon docs page walks through the
 * `httpAction` recipe that has access to inbound `Headers`. This demo
 * keeps the handler simple and trusts the per-document `ownerId` for
 * isolation; production apps want the membership check too.
 */
const assertSignedIn = (userId: null | string): string => {
    if (!userId) {
        throw new LunoraError("UNAUTHORIZED", "not signed in");
    }

    return userId;
};

/**
 * List documents in an organization, newest-first. Anyone signed in can call
 * this; pair it with `withAuthPlugins` to add a strict membership check.
 */
export const list = query.input({ organizationId: v.string() }).query(async ({ args: { organizationId }, ctx }): Promise<DocumentRow[]> => {
    assertSignedIn(ctx.auth.userId);

    const rows = (await ctx.db
        .query("documents")
        .withIndex("by_org_created", (range) => range.eq("organizationId", organizationId))
        .collect()) as unknown as DocumentRow[];

    return [...rows].sort((a, b) => b.createdAt - a.createdAt);
});

export const create = mutation
    .input({
        organizationId: v.string(),
        title: v.string(),
        body: v.string(),
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
