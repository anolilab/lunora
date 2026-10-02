import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import type { QueryCtx as QueryContext } from "./_generated/server.js";
import { internalMutation, mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg } from "./authz";
import { pendingTeardown } from "./deployments";
import { assertWithinQuota } from "./entitlements";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

/**
 * Cloudflare accounts an organization connected for the `cloudflare-workers`
 * target (MULTIPLATFORM.md Phase 3 — the ROADMAP's "connect-your-Cloudflare
 * onboarding"): its projects deploy as plain Workers into its own account.
 *
 * The credential is a scoped API token the organization creates in its own
 * dashboard and pastes once. Cloudflare's OAuth for third-party clients
 * (developers.cloudflare.com/fundamentals/oauth/) is the follow-up: it would
 * replace the paste with a consent screen and a refreshable grant, but the
 * stored-credential shape and every check below stay the same.
 *
 * The token is verified and encrypted at the edge, never here:
 * `POST /v1/cloudflare-accounts` checks it against the account
 * (`inspectAccount`, `src/targets/cloudflare-workers/api.ts`), seals it with
 * `SECRET_ENCRYPTION_KEY`, and only then calls {@link connect} under the
 * caller's session. These functions see ciphertext + IV and nothing else, and
 * no query ever returns either.
 */

/** A `cloudflareAccounts` row as the store returns it. `.global()` rows answer SQL NULL for an unset column. */
interface AccountRow {
    _id: Id<"cloudflareAccounts">;
    accountId: string;
    createdAt: number;
    displayName?: null | string;
    label: string;
    organizationId: Id<"organizations">;
    permissions: string[];
    tokenExpiresAt?: null | number;
    verifiedAt: number;
    workersSubdomain: string;
}

/** A connected account as the studio sees it — explicitly projected, so the ciphertext can never ride along. */
export interface CloudflareAccountView {
    _id: Id<"cloudflareAccounts">;
    accountId: string;
    createdAt: number;
    displayName?: string;
    label: string;
    organizationId: Id<"organizations">;
    /** The permission groups the token was seen to hold when last verified. */
    permissions: string[];
    tokenExpiresAt?: number;
    verifiedAt: number;
    workersSubdomain: string;
}

export const toCloudflareAccountView = (row: AccountRow): CloudflareAccountView => {
    return {
        _id: row._id,
        accountId: row.accountId,
        createdAt: row.createdAt,
        label: row.label,
        organizationId: row.organizationId,
        permissions: [...row.permissions],
        verifiedAt: row.verifiedAt,
        workersSubdomain: row.workersSubdomain,
        ...(row.displayName == null ? {} : { displayName: row.displayName }),
        ...(row.tokenExpiresAt == null ? {} : { tokenExpiresAt: row.tokenExpiresAt }),
    };
};

/** An organization's connected accounts (members). */
export const list = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<CloudflareAccountView[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.cloudflareAccounts.findMany({ where: { organizationId } });

        return (page as AccountRow[]).map((row) => toCloudflareAccountView(row)).toSorted((a, b) => b.createdAt - a.createdAt);
    });

/** What still deploys into a connected account, so disconnecting it would strand a tenant. */
const usersOf = async (
    context: QueryContext,
    organizationId: Id<"organizations">,
    id: Id<"cloudflareAccounts">,
): Promise<{ deployments: number; projects: number }> => {
    const { page: projects } = await context.db.projects.findMany({ where: { cloudflareAccountId: id, organizationId } });
    const { page: deployments } = await context.db.deployments.findMany({ where: { cloudflareAccountId: id } });
    // A deployment counts until the teardown sweep has reclaimed it: its Worker and
    // data still live in the account, and only this token can remove them.
    return { deployments: pendingTeardown(deployments).length, projects: projects.length };
};

/** The verified, sealed token the edge route hands {@link connect}. */
const connection = {
    accountId: boundedString(LIMITS.id),
    displayName: v.optional(boundedString(LIMITS.name)),
    ciphertext: boundedString(LIMITS.secret),
    iv: boundedString(LIMITS.id),
    permissions: v.array(boundedString(LIMITS.tag)),
    tokenExpiresAt: v.optional(v.number()),
    workersSubdomain: boundedString(LIMITS.hostname),
};

/**
 * Connect an account, or rotate the token of one already connected (owner/admin,
 * under the caller's session).
 *
 * Internal: only `POST /v1/cloudflare-accounts` may call it, because only that
 * route verifies the token against the account before sealing it. Over RPC a
 * caller could store a token nobody checked.
 *
 * Rotating (`id` set) keeps the row — every project and deployment that names
 * it follows — and refuses a token for a DIFFERENT account: the tenants live in
 * the old one, and a token that cannot reach them could never tear them down.
 * Connecting an account the organization already connected is refused too;
 * that is a rotation.
 */
export const connect = internalMutation
    .use(rateLimit("sensitive"))
    .input({
        ...connection,
        id: v.optional(v.id("cloudflareAccounts")),
        label: boundedString(LIMITS.name),
        organizationId: v.id("organizations"),
    })
    .mutation(async ({ ctx: context, args: { id, label, organizationId, ...verified } }): Promise<Id<"cloudflareAccounts">> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);
        const fields = {
            accountId: verified.accountId,
            ...(verified.displayName === undefined ? {} : { displayName: verified.displayName }),
            ciphertext: verified.ciphertext,
            iv: verified.iv,
            permissions: verified.permissions,
            ...(verified.tokenExpiresAt === undefined ? {} : { tokenExpiresAt: verified.tokenExpiresAt }),
            updatedAt: context.now,
            verifiedAt: context.now,
            workersSubdomain: verified.workersSubdomain,
        };

        if (id !== undefined) {
            await assertRowInOrg(context, id, organizationId, "Cloudflare account");

            const row = (await context.db.get(id)) as AccountRow;

            if (row.accountId !== verified.accountId) {
                throw new LunoraError(
                    "CONFLICT",
                    `this connection is for Cloudflare account ${row.accountId}; a token for ${verified.accountId} cannot replace it, because the projects deployed there could no longer be reached`,
                );
            }

            await context.db.patch(id, { ...fields, ...(label.trim() === "" ? {} : { label: label.trim() }) });
            await context.db.insert("auditLog", {
                action: "cloudflare_account.rotate",
                actorUserId: member.userId,
                createdAt: context.now,
                organizationId,
                target: row.accountId,
            });

            return id;
        }

        const { page } = await context.db.cloudflareAccounts.findMany({ where: { organizationId } });

        if ((page as AccountRow[]).some((row) => row.accountId === verified.accountId)) {
            throw new LunoraError("CONFLICT", `Cloudflare account ${verified.accountId} is already connected; rotate its token instead`);
        }

        await assertWithinQuota(context, organizationId, "cloudflareAccounts", page.length);

        const created = await context.db.insert("cloudflareAccounts", {
            ...fields,
            createdAt: context.now,
            createdBy: member.userId,
            label: label.trim() === "" ? verified.accountId : label.trim(),
            organizationId,
        });

        await context.db.insert("auditLog", {
            action: "cloudflare_account.connect",
            actorUserId: member.userId,
            createdAt: context.now,
            organizationId,
            target: verified.accountId,
        });

        return created;
    });

/**
 * Disconnect an account (owner/admin): its row and the sealed token go.
 *
 * Refused while any project of the organization deploys there, or any
 * deployment there has not been torn down — the token is what reaches those
 * Workers and their data, and without it Lunora Cloud could neither update nor
 * remove them. Move the projects to another target (which itself waits for
 * teardown) first. Revoke the token in Cloudflare's dashboard as well: deleting
 * it here does not invalidate it there.
 */
export const disconnect = mutation
    .use(rateLimit("sensitive"))
    .input({ id: v.id("cloudflareAccounts"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, organizationId } }): Promise<void> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);

        await assertRowInOrg(context, id, organizationId, "Cloudflare account");

        const row = (await context.db.get(id)) as AccountRow;
        const users = await usersOf(context, organizationId, id);

        if (users.projects > 0 || users.deployments > 0) {
            throw new LunoraError(
                "CONFLICT",
                `${String(users.projects)} project(s) and ${String(users.deployments)} deployment(s) still deploy into this account; move the projects to another target and wait for teardown before disconnecting it`,
            );
        }

        await context.db.delete(id);
        await context.db.insert("auditLog", {
            action: "cloudflare_account.disconnect",
            actorUserId: member.userId,
            createdAt: context.now,
            organizationId,
            target: row.accountId,
        });
    });
