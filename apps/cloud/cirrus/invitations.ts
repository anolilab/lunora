import { CirrusError } from "@cirrus/server";

import { randomSecret, sha256Hex } from "../src/deploy/keys";
import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg } from "./authz";

/**
 * Team invitations (CLOUD-PLAN.md §3 / Phase 3). An owner/admin invites an email
 * with a role; the invitee accepts via a single-use token (mailed to them, only
 * its SHA-256 hash is stored). Accepting adds them as a member.
 */

/** Invitations expire after 7 days. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const role = v.union(v.literal("owner"), v.literal("admin"), v.literal("member"), v.literal("viewer"));

interface InvitationRow {
    _id: Id<"invitations">;
    createdAt: number;
    email: string;
    expiresAt: number;
    invitedBy: string;
    organizationId: Id<"organizations">;
    role: "admin" | "member" | "owner" | "viewer";
    status: "accepted" | "pending" | "revoked";
    tokenHash: string;
}

/** Public view of an invitation — never exposes the token hash. */
type InvitationView = Omit<InvitationRow, "tokenHash">;

/** List an organization's invitations (any member may view). */
export const list = query({
    args: { organizationId: v.id("organizations") },
    handler: async (context, { organizationId }): Promise<InvitationView[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.invitations.findMany({ where: { organizationId } });

        return (page as unknown as InvitationRow[]).map(({ tokenHash: _tokenHash, ...view }) => view);
    },
});

/**
 * Invite an email to an organization (owners/admins only). Returns the
 * single-use token **once** — the caller mails it; only its hash is persisted.
 */
export const invite = mutation({
    args: { email: v.string(), organizationId: v.id("organizations"), role },
    handler: async (context, arguments_): Promise<{ id: Id<"invitations">; token: string }> => {
        const { userId } = await assertMember(context, arguments_.organizationId, ["owner", "admin"]);
        const now = Date.now();
        const token = randomSecret();

        const id = await context.db.insert("invitations", {
            createdAt: now,
            email: arguments_.email,
            expiresAt: now + INVITE_TTL_MS,
            invitedBy: userId,
            organizationId: arguments_.organizationId,
            role: arguments_.role,
            status: "pending",
            tokenHash: await sha256Hex(token),
        });

        return { id, token };
    },
});

/** Revoke a pending invitation (owners/admins only). */
export const revoke = mutation({
    args: { id: v.id("invitations"), organizationId: v.id("organizations") },
    handler: async (context, { id, organizationId }): Promise<void> => {
        await assertMember(context, organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, id, organizationId, "invitation");

        await context.db.patch(id, { status: "revoked" });
    },
});

/**
 * Accept an invitation by its token (the signed-in invitee). Possession of the
 * token — mailed to the invited address — is the proof. Adds the caller as a
 * member with the invited role and marks the invitation accepted.
 */
export const accept = mutation({
    args: { token: v.string() },
    handler: async (context, { token }): Promise<{ organizationId: Id<"organizations"> }> => {
        const { userId } = context.auth;

        if (!userId) {
            throw new CirrusError("UNAUTHORIZED", "not signed in");
        }

        const tokenHash = await sha256Hex(token);
        const { page } = await context.db.invitations.findMany({ where: { tokenHash } });
        const invitation = (page as unknown as InvitationRow[])[0];

        if (invitation?.status !== "pending" || invitation.expiresAt < Date.now()) {
            throw new CirrusError("FORBIDDEN", "invitation is invalid, revoked, or expired");
        }

        const members = await context.db.members.findMany({ where: { organizationId: invitation.organizationId, userId } });

        if ((members.page as unknown as unknown[]).length === 0) {
            await context.db.insert("members", {
                createdAt: Date.now(),
                organizationId: invitation.organizationId,
                role: invitation.role,
                userId,
            });
        }

        await context.db.patch(invitation._id, { status: "accepted" });

        return { organizationId: invitation.organizationId };
    },
});
