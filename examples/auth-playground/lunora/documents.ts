import { rateLimit } from "lunorash/ratelimit";
import { LunoraError } from "lunorash/server";

import type { Id, MutationCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";
import { makeRateLimiter } from "./ratelimit/schema.js";

/**
 * The limiter comes from `lunora/ratelimit/schema.ts`, which owns the named
 * limits and the durable store.
 *
 * Keyed on the signed-in user so one account cannot spend another's budget. The
 * `ctx.ip` fallback matters: the rate-limit middleware runs *before* the handler
 * calls `assertSignedIn`, so every unauthenticated attempt is keyed here before
 * it is rejected. `ctx.ip` is Cloudflare's server-side `CF-Connecting-IP` and is
 * `undefined` off Cloudflare, where those attempts then share one `"anon"`
 * bucket.
 */
const limiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byUser = { key: (ctx: { auth: { userId?: null | string }; ip?: string }): string => ctx.auth.userId ?? ctx.ip ?? "anon" };

interface DocumentRow {
    _id: Id<"documents">;
    body: string;
    createdAt: number;
    ownerId: string;
    title: string;
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
 * What isolates these documents — and why there is no `organizationId` column.
 *
 * `ownerId` is stamped from the session on `create` and is the equality prefix
 * of every read, so a caller only ever sees their own rows. That is a boundary
 * the server can enforce on its own.
 *
 * An `organizationId` would not be. A procedure context carries the resolved
 * identity and nothing else — no org claim, and no inbound `Headers` — so an
 * org id could only arrive in `args`, where the caller picks it. Storing one
 * there produces a column that *looks* like a tenant boundary and is really a
 * caller-chosen label: `assertSignedIn` proves the caller is somebody, never
 * that they belong to the org they named. Writing rows under another tenant's
 * id is then one request away, and every later query that trusts the column
 * inherits the hole. A field the server cannot verify does not belong in the
 * row.
 *
 * To scope by organization for real, put the check where the request is: a
 * better-auth membership lookup authorizes from the caller's session cookie, so
 * compose `withAuthPlugins(auth)` onto an `httpAction` — which does have the
 * request — and call `ctx.authApi.getActiveMember({ headers: request.headers,
 * query: { organizationId } })` before the org id is allowed anywhere near a
 * write. Add the column once that gate exists, not before.
 */
export const list = query.query(async ({ ctx }): Promise<DocumentRow[]> => {
    const userId = assertSignedIn(ctx.auth.userId);

    // The equality prefix pins the row set to this caller's own documents; the
    // index's trailing `createdAt` supplies the ordering, so nothing is sorted
    // (or over-read) in JS.
    return ctx.db
        .query("documents")
        .withIndex("by_owner_created", (range) => range.eq("ownerId", userId))
        .order("desc")
        .collect();
});

/** File a new document. `ownerId` comes from the session, never from `args`. */
export const create = mutation
    .use(rateLimit(limiter, "write", byUser))
    .input({
        title: v.string().max(256),
        body: v.string().max(100_000),
    })
    .mutation(async ({ args: { title, body }, ctx }): Promise<Id<"documents">> => {
        const userId = assertSignedIn(ctx.auth.userId);

        return ctx.db.insert("documents", {
            ownerId: userId,
            title,
            body,
            createdAt: Date.now(),
        });
    });
