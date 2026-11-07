/**
 * Seat holds for pending invitations.
 *
 * better-auth checks `membershipLimit` only when a member is added or an
 * invitation accepted, so `lunora/auth/index.ts` also refuses an invitation the
 * organisation has no seat left for. A count followed by better-auth's own write
 * is not atomic: two invitations racing for the last seat would both pass it.
 * The hold is the reservation that is — mutations on one shard run one at a
 * time, so {@link holdInvitationSeat} counts and writes as one step. A hold is
 * released when its invitation is accepted, rejected or cancelled, and lapses
 * with it otherwise.
 */
import { LunoraError } from "@lunora/errors";
import { internalMutation, v } from "#lunora/_generated/server.js";
import type { Doc, QueryCtx } from "#lunora/_generated/server.js";

/** How long an invitation, and so its hold, lasts — passed to better-auth as `invitationExpiresIn`. */
export const INVITATION_EXPIRES_SECONDS = 48 * 60 * 60;

const holdsOf = async (ctx: QueryCtx, organizationId: string): Promise<Doc<"invitation_holds">[]> =>
    ctx.db
        .query("invitation_holds")
        .withIndex("byOrganizationEmail", (q) => q.eq("organizationId", organizationId))
        .collect();

/** Lapsed holds removed per invitation: a bounded batch, so one invitation never reads an organisation's whole history. */
const EXPIRED_BATCH = 50;

/**
 * Reserve a seat for an invitation to `email`, or refuse with `FORBIDDEN` when
 * `members` plus the organisation's live holds already fill `limit` (`null`: no
 * cap). Re-inviting an address renews its hold instead of taking a second seat.
 */
export const holdInvitationSeat = internalMutation
    .input({ email: v.string(), limit: v.union(v.number(), v.null()), members: v.number(), organizationId: v.string() })
    .mutation(async ({ args: { email, limit, members, organizationId }, ctx }): Promise<void> => {
        const address = email.trim().toLowerCase();
        const expiresAt = ctx.now + INVITATION_EXPIRES_SECONDS * 1000;
        const existing = await ctx.db
            .query("invitation_holds")
            .withIndex("byOrganizationEmail", (q) => q.eq("organizationId", organizationId).eq("email", address))
            .first();

        if (existing !== null && existing.expiresAt > ctx.now) {
            await ctx.db.patch("invitation_holds", existing._id, { expiresAt });

            return;
        }

        // A lapsed hold for the address goes first, so the unique address row can be written again.
        const lapsed = await ctx.db
            .query("invitation_holds")
            .withIndex("byOrganizationExpiry", (q) => q.eq("organizationId", organizationId).lte("expiresAt", ctx.now))
            .take(EXPIRED_BATCH);

        await Promise.all(lapsed.map(async (hold) => ctx.db.delete("invitation_holds", hold._id)));

        if (existing !== null && !lapsed.some((hold) => hold._id === existing._id)) {
            await ctx.db.delete("invitation_holds", existing._id);
        }

        // Only a capped plan counts its holds, and the table is bounded by that cap; an uncapped one has no seats to count.
        if (limit !== null) {
            const holds = await ctx.db
                .query("invitation_holds")
                .withIndex("byOrganizationEmail", (q) => q.eq("organizationId", organizationId))
                .collect();
            const live = holds.filter((hold) => hold.expiresAt > ctx.now).length;

            if (members + live >= limit) {
                throw new LunoraError("FORBIDDEN", "every seat on this plan is taken or invited — upgrade the plan to invite more");
            }
        }

        await ctx.db.insert("invitation_holds", { email: address, expiresAt, organizationId });
    });

/** Give back the seat an invitation held: it was accepted (now a member), rejected or cancelled. */
export const releaseInvitationSeat = internalMutation
    .input({ email: v.string(), organizationId: v.string() })
    .mutation(async ({ args: { email, organizationId }, ctx }): Promise<void> => {
        const address = email.trim().toLowerCase();
        const hold = (await holdsOf(ctx, organizationId)).find((row) => row.email === address);

        if (hold !== undefined) {
            await ctx.db.delete("invitation_holds", hold._id);
        }
    });
