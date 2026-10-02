import type { BoxVersions } from "@lunora/hostd/protocol";
import { isVersion } from "@lunora/hostd/protocol";
import { LunoraError } from "@lunora/server";

import { isPublicIpv4, isPublicIpv6 } from "../src/boxes/addresses";
import { isBoxPublicKey } from "../src/boxes/encoding";
import { ENROLMENT_TTL_MS, installCommandFor, mintBoxSlug, mintEnrolmentToken } from "../src/boxes/enrolment";
import type { StoredReleaseSummary } from "../src/boxes/hostd-releases";
import { newestStableRelease } from "../src/boxes/hostd-releases";
import { boxDomainOf } from "../src/boxes/urls";
import { sha256Hex } from "../src/deploy/keys";
import { DEFAULT_TARGET, isBoxTarget, storedTarget } from "../src/provision-contract";
import { revokedBoxError } from "../src/targets/placement";
import type { Id } from "./_generated/dataModel.js";
import type { QueryCtx as QueryContext } from "./_generated/server.js";
import { action, internalMutation, internalQuery, mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg } from "./authz";
import { assertWithinQuota, orgLimit } from "./entitlements";
import { rateLimit } from "./guards";
import { deployTarget } from "./tables/shared";
import { boundedString, LIMITS } from "./validators";

/**
 * Customer boxes (plan 458 G12): machines an organization runs `lunora-hostd`
 * on, so its `celld-vps` projects deploy there.
 *
 * The lifecycle is: an owner mints a one-time enrolment token
 * ({@link createEnrolment}); `hostd enrol` presents it with the box's freshly
 * generated public key to `POST /v1/boxes/enrol`, which consumes it
 * ({@link enrol}); the box then holds a WebSocket session with its
 * `BoxSessionDO` (`src/boxes/session-do.ts`), which keeps `status`,
 * `lastSeenAt`, `versions` and `resources` current. {@link revoke} ends it for
 * good — the session closes and the box's DNS records go
 * (`POST /v1/boxes/revoke`, its only caller); the box sweep
 * (`src/boxes/reconcile.ts`) removes any record a revoke or an org purge left.
 */

type BoxStatus = "offline" | "online" | "pending" | "revoked";

/** A `boxes` row as the store returns it. `.global()` rows answer SQL NULL for an unset column. */
interface BoxRow {
    _id: Id<"boxes">;
    createdAt: number;
    desiredReleaseId?: null | string;
    dnsError?: null | string;
    enrolledAt?: null | number;
    ipv4?: null | string;
    ipv6?: null | string;
    lastSeenAt?: null | number;
    name: string;
    organizationId: Id<"organizations">;
    publicKey: string;
    resources?: null | { diskFreeMb: number; memMb: number };
    revokedAt?: null | number;
    singleTrust: boolean;
    slug: string;
    status: BoxStatus;
    versions?: BoxVersions | null;
}

/** An org's boxes that count against its `boxes` limit: every one not revoked. */
const activeBoxCount = async (context: QueryContext, organizationId: Id<"organizations">): Promise<number> => {
    const { page } = await context.db.boxes.findMany({ where: { organizationId } });

    return (page as BoxRow[]).filter((row) => row.status !== "revoked").length;
};

/** A box as the studio sees it. Explicitly projected, so a column added to the row later is not exposed by default. */
export interface BoxView {
    _id: Id<"boxes">;
    createdAt: number;
    desiredReleaseId?: string;
    /** Why the box's DNS records could not be written, when they could not. */
    dnsError?: string;
    enrolledAt?: number;
    ipv4?: string;
    ipv6?: string;
    lastSeenAt?: number;
    name: string;
    organizationId: Id<"organizations">;

    /**
     * The box runs a celld other than the newest stable `lunora-hostd` release's
     * (plan 458 W7). celld patches only its latest release, so an outdated box is
     * a security finding, not a cosmetic one. False while either side is unknown.
     */
    outdated: boolean;
    /** The box's Ed25519 public key (raw, base64url) — public by definition, shown so an operator can match it to the box. */
    publicKey: string;
    resources?: { diskFreeMb: number; memMb: number };
    revokedAt?: number;
    singleTrust: boolean;
    slug: string;
    status: BoxStatus;
    versions?: BoxVersions;
}

/** Copy the set fields of a row onto the view; NULL and undefined both mean unset. */
const present = <T>(key: string, value: null | T | undefined): Record<string, T> => (value == null ? {} : { [key]: value });

/** The newest stable release's versions, which boxes are measured against; `null` before any release is stored. */
const latestStableVersions = async (context: QueryContext): Promise<BoxVersions | null> => {
    const { page } = await context.db.hostdReleases.findMany({});

    return newestStableRelease(page as StoredReleaseSummary[])?.versions ?? null;
};

export const toBoxView = (row: BoxRow, latest: BoxVersions | null = null): BoxView => {
    return {
        _id: row._id,
        createdAt: row.createdAt,
        name: row.name,
        organizationId: row.organizationId,
        outdated: latest !== null && row.versions != null && row.status !== "revoked" && row.versions.celld !== latest.celld,
        publicKey: row.publicKey,
        singleTrust: row.singleTrust,
        slug: row.slug,
        status: row.status,
        ...present("desiredReleaseId", row.desiredReleaseId),
        ...present("dnsError", row.dnsError),
        ...present("enrolledAt", row.enrolledAt),
        ...present("ipv4", row.ipv4),
        ...present("ipv6", row.ipv6),
        ...present("lastSeenAt", row.lastSeenAt),
        ...present("resources", row.resources),
        ...present("revokedAt", row.revokedAt),
        ...present("versions", row.versions),
    };
};

/**
 * Mint a one-time enrolment token for a new box (owner/admin). The plaintext
 * token is returned ONCE, with the command that uses it; only its SHA-256 is
 * stored, and it expires after 15 minutes (plan 458 D4).
 */
export const createEnrolment = mutation
    .use(rateLimit("sensitive"))
    .input({ name: boundedString(LIMITS.name), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { name, organizationId } }): Promise<{ expiresAt: number; installCommand: string; token: string }> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);

        if (name.trim() === "") {
            throw new LunoraError("BAD_REQUEST", "a box needs a name");
        }

        // An unused, unexpired token is a box on its way: counting it stops an owner
        // minting past the plan's limit and enrolling the boxes afterwards.
        const { page: enrolments } = await context.db.boxEnrolments.findMany({ where: { organizationId } });
        const pending = (enrolments as { expiresAt: number; usedAt?: null | number }[]).filter(
            (row) => row.usedAt == null && row.expiresAt > context.now,
        ).length;

        await assertWithinQuota(context, organizationId, "boxes", (await activeBoxCount(context, organizationId)) + pending);

        const token = mintEnrolmentToken();
        const expiresAt = context.now + ENROLMENT_TTL_MS;

        await context.db.insert("boxEnrolments", {
            createdAt: context.now,
            createdBy: member.userId,
            expiresAt,
            hashedToken: await sha256Hex(token),
            name: name.trim(),
            organizationId,
        });
        await context.db.insert("auditLog", {
            action: "box.enrolment.create",
            actorUserId: member.userId,
            createdAt: context.now,
            organizationId,
            target: name.trim(),
        });

        return { expiresAt, installCommand: installCommandFor(token), token };
    });

/** An organization's boxes, revoked ones included (members). */
export const list = query.input({ organizationId: v.id("organizations") }).query(async ({ ctx: context, args: { organizationId } }): Promise<BoxView[]> => {
    await assertMember(context, organizationId);

    const { page } = await context.db.boxes.findMany({ where: { organizationId } });

    const latest = await latestStableVersions(context);

    return (page as BoxRow[]).map((row) => toBoxView(row, latest)).toSorted((a, b) => b.createdAt - a.createdAt);
});

/** One box of an organization (members). `null` for a box that is not this organization's. */
export const get = query
    .input({ id: v.id("boxes"), organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { id, organizationId } }): Promise<BoxView | null> => {
        await assertMember(context, organizationId);

        const row = (await context.db.get(id)) as BoxRow | null;

        return row?.organizationId === organizationId ? toBoxView(row, await latestStableVersions(context)) : null;
    });

/**
 * The apex a box's default hostname lives under (`{slug}.{domain}`; a tenant on
 * it is `{alias}.{slug}.{domain}`, plan 458 D9), for the studio's Boxes tab
 * (members).
 *
 * An action because `LUNORA_BOX_DOMAIN` is a Worker var and only actions carry
 * `ctx.env`; the box list itself stays a live query.
 */
export const domain = action
    .use(rateLimit("api"))
    .input({ organizationId: v.id("organizations") })
    .action(async ({ ctx: context, args: { organizationId } }): Promise<string> => {
        await assertMember(context, organizationId);

        return boxDomainOf(context.env ?? {});
    });

/** Rename a box (owner/admin). The slug — its DNS label — never changes. */
export const rename = mutation
    .use(rateLimit("api"))
    .input({ id: v.id("boxes"), name: boundedString(LIMITS.name), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, name, organizationId } }): Promise<void> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);

        await assertRowInOrg(context, id, organizationId, "box");

        if (name.trim() === "") {
            throw new LunoraError("BAD_REQUEST", "a box needs a name");
        }

        await context.db.patch(id, { name: name.trim() });
        await context.db.insert("auditLog", { action: "box.rename", actorUserId: member.userId, createdAt: context.now, organizationId, target: name.trim() });
    });

/**
 * Revoke a box for good (owner/admin, checked against the caller's session).
 * The row stays, `revoked`, so its history and audit trail survive; the machine
 * enrols again as a new box. Idempotent.
 *
 * Internal on purpose: revoking is only complete with the box's session closed
 * and its DNS records removed, which a mutation cannot do. `POST /v1/boxes/revoke`
 * is the one path — it runs this under the caller's identity, then closes the
 * session and removes the records with what it returns. Were this callable over
 * RPC, a revoke made that way would leave `*.{slug}` pointing at an address the
 * customer may release (until the box sweep's next pass removed it).
 */
export const revoke = internalMutation
    .use(rateLimit("sensitive"))
    .input({ id: v.id("boxes"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, organizationId } }): Promise<{ ipv4?: string; ipv6?: string; slug: string }> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);

        await assertRowInOrg(context, id, organizationId, "box");

        const row = (await context.db.get(id)) as BoxRow;

        if (row.status !== "revoked") {
            await context.db.patch(id, { revokedAt: context.now, status: "revoked" });
            await context.db.insert("auditLog", { action: "box.revoke", actorUserId: member.userId, createdAt: context.now, organizationId, target: row.slug });
        }

        return { slug: row.slug, ...present("ipv4", row.ipv4), ...present("ipv6", row.ipv6) };
    });

/**
 * Point a project at a deploy target (owner/admin) — the one writer of
 * `projects.target` and `projects.boxId`. A `celld-vps` project names a box of
 * the same organization that is not revoked; any other target clears the box.
 *
 * Refused while the project still has a deployment the teardown sweep has not
 * reclaimed: its tenant (and its data) lives on the CURRENT target, and the
 * sweep would send that teardown — keyed by alias — to the new one.
 */
export const setProjectTarget = mutation
    .use(rateLimit("sensitive"))
    .input({
        boxId: v.optional(v.id("boxes")),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
        target: deployTarget,
    })
    .mutation(async ({ ctx: context, args: { boxId, organizationId, projectId, target } }): Promise<void> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);

        await assertRowInOrg(context, projectId, organizationId, "project");

        if (isBoxTarget(target)) {
            if (boxId === undefined) {
                throw new LunoraError("BAD_REQUEST", `a ${target} project needs a box (boxId)`);
            }

            const box = (await context.db.get(boxId)) as BoxRow | null;

            if (box?.organizationId !== organizationId) {
                throw new LunoraError("NOT_FOUND", "box not found in this organization");
            }

            if (box.status === "revoked") {
                throw revokedBoxError(box.name);
            }
        } else if (boxId !== undefined) {
            throw new LunoraError("BAD_REQUEST", `a ${target} project has no box`);
        }

        const project = (await context.db.get(projectId)) as { boxId?: null | string; target?: null | string };
        const currentTarget = storedTarget(project.target) ?? DEFAULT_TARGET;
        const currentBox = project.boxId ?? undefined;

        if (currentTarget === target && currentBox === boxId) {
            return;
        }

        const { page: deployments } = await context.db.deployments.findMany({ where: { projectId } });
        const pending = (deployments as { status: string; teardownAt?: null | number }[]).filter((row) => row.status !== "destroyed" || row.teardownAt == null);

        if (pending.length > 0) {
            throw new LunoraError(
                "CONFLICT",
                `this project still has ${String(pending.length)} deployment(s) on ${currentTarget}; delete the project's deployments and wait for teardown before moving it`,
            );
        }

        await context.db.patch(projectId, { boxId: boxId ?? null, target });
        await context.db.insert("auditLog", {
            action: "project.target.set",
            actorUserId: member.userId,
            createdAt: context.now,
            organizationId,
            target: boxId === undefined ? target : `${target}:${boxId}`,
        });
    });

/** Refuse an enrolment whose key, addresses or versions are malformed — before the token is touched. */
const assertEnrolmentShape = (args: { ipv4?: string; ipv6?: string; publicKey: string; versions: BoxVersions }): void => {
    if (!isBoxPublicKey(args.publicKey)) {
        throw new LunoraError("BAD_REQUEST", "publicKey must be a raw Ed25519 public key, base64url without padding (43 characters)");
    }

    if (args.ipv4 !== undefined && !isPublicIpv4(args.ipv4)) {
        throw new LunoraError("BAD_REQUEST", "ipv4 must be a public IPv4 address");
    }

    if (args.ipv6 !== undefined && !isPublicIpv6(args.ipv6)) {
        throw new LunoraError("BAD_REQUEST", "ipv6 must be a global unicast IPv6 address");
    }

    if (args.ipv4 === undefined && args.ipv6 === undefined) {
        throw new LunoraError("BAD_REQUEST", "a box must report a public IPv4 or IPv6 address — its hostnames point there");
    }

    if (![args.versions.caddy, args.versions.celld, args.versions.hostd].every((version) => isVersion(version))) {
        throw new LunoraError("BAD_REQUEST", "versions must be 1-64 characters of [A-Za-z0-9_.+~-]");
    }
};

/** What `POST /v1/boxes/enrol` answers a box. */
export interface EnrolResult {
    boxId: Id<"boxes">;
    /** False when this was a retry of an enrolment that already created the box. */
    created: boolean;
    ipv4?: string;
    ipv6?: string;
    organizationId: Id<"organizations">;
    slug: string;
}

/**
 * Consume an enrolment token and create the box (SYSTEM — the token-gated
 * `POST /v1/boxes/enrol` route, which hashes the token at the edge).
 *
 * Single use. A retry with the SAME public key after the token was consumed —
 * `hostd` lost the first answer — returns the box it created; the same token
 * with any other key is a replay and is refused. Expired and unknown tokens are
 * refused alike, without saying which.
 */
export const enrol = internalMutation
    .input({
        hashedToken: boundedString(LIMITS.id),
        ipv4: v.optional(boundedString(LIMITS.id)),
        ipv6: v.optional(boundedString(LIMITS.id)),
        publicKey: boundedString(LIMITS.id),
        singleTrust: v.boolean(),
        versions: v.object({ caddy: boundedString(LIMITS.id), celld: boundedString(LIMITS.id), hostd: boundedString(LIMITS.id) }),
    })
    .mutation(async ({ ctx: context, args }): Promise<EnrolResult> => {
        assertEnrolmentShape(args);

        const { page } = await context.db.boxEnrolments.findMany({ where: { hashedToken: args.hashedToken } });
        const enrolment = page[0] as
            | undefined
            | {
                  _id: Id<"boxEnrolments">;
                  boxId?: Id<"boxes"> | null;
                  expiresAt: number;
                  name: string;
                  organizationId: Id<"organizations">;
                  usedAt?: null | number;
              };

        if (!enrolment) {
            throw new LunoraError("FORBIDDEN", "invalid or expired enrolment token");
        }

        if (enrolment.usedAt != null) {
            const existing = enrolment.boxId == null ? null : ((await context.db.get(enrolment.boxId)) as BoxRow | null);

            if (existing?.publicKey === args.publicKey && existing.status !== "revoked") {
                return {
                    boxId: existing._id,
                    created: false,
                    organizationId: existing.organizationId,
                    slug: existing.slug,
                    ...present("ipv4", existing.ipv4),
                    ...present("ipv6", existing.ipv6),
                };
            }

            throw new LunoraError("FORBIDDEN", "this enrolment token was already used; mint a new one in the studio");
        }

        if (enrolment.expiresAt <= context.now) {
            throw new LunoraError("FORBIDDEN", "invalid or expired enrolment token");
        }

        // Re-checked at consumption: the plan may have shrunk since the token was minted.
        const limit = await orgLimit(context, enrolment.organizationId, "boxes");

        if ((await activeBoxCount(context, enrolment.organizationId)) >= limit) {
            throw new LunoraError("FORBIDDEN", `boxes quota reached for this plan (limit ${String(limit)})`);
        }

        const slug = mintBoxSlug();
        const boxId = await context.db.insert("boxes", {
            createdAt: context.now,
            enrolledAt: context.now,
            ipv4: args.ipv4,
            ipv6: args.ipv6,
            name: enrolment.name,
            organizationId: enrolment.organizationId,
            publicKey: args.publicKey,
            singleTrust: args.singleTrust,
            slug,
            status: "pending",
            versions: args.versions,
        });

        await context.db.patch(enrolment._id, { boxId, usedAt: context.now });
        await context.db.insert("auditLog", {
            action: "box.enrol",
            actorUserId: "system:box-enrol",
            createdAt: context.now,
            organizationId: enrolment.organizationId,
            target: slug,
        });

        return {
            boxId,
            created: true,
            organizationId: enrolment.organizationId,
            slug,
            ...present("ipv4", args.ipv4),
            ...present("ipv6", args.ipv6),
        };
    });

/**
 * Record the outcome of writing (or removing) a box's DNS records (SYSTEM —
 * the enrol and revoke routes). `null` clears a previous failure.
 */
export const recordDns = internalMutation
    .input({ boxId: v.id("boxes"), dnsError: v.union(v.null(), boundedString(LIMITS.token)) })
    .mutation(async ({ ctx: context, args: { boxId, dnsError } }): Promise<void> => {
        await context.db.patch(boxId, { dnsError });
    });

/**
 * A box's identity as a signed request is checked against it (SYSTEM — the
 * box-signed routes). `null` for an unknown box.
 */
export const identity = internalQuery
    .input({ boxId: v.id("boxes") })
    .query(
        async ({
            ctx: context,
            args: { boxId },
        }): Promise<null | { organizationId: Id<"organizations">; publicKey: string; revoked: boolean; slug: string }> => {
            const row = (await context.db.get(boxId)) as BoxRow | null;

            return row ? { organizationId: row.organizationId, publicKey: row.publicKey, revoked: row.status === "revoked", slug: row.slug } : null;
        },
    );

/**
 * Whether box `boxId` may download deployment `deploymentId`'s release (SYSTEM
 * — the box-signed `GET /v1/boxes/releases/:deploymentId`): only a box-placed
 * deployment of a project placed on THAT box, in the box's own organization.
 */
export const ownsDeployment = internalQuery
    .input({ boxId: v.id("boxes"), deploymentId: v.id("deployments") })
    .query(async ({ ctx: context, args: { boxId, deploymentId } }): Promise<boolean> => {
        const deployment = (await context.db.get(deploymentId)) as null | { organizationId: string; projectId: Id<"projects">; target?: null | string };
        const target = deployment ? storedTarget(deployment.target) : undefined;

        if (deployment === null || target === undefined || !isBoxTarget(target)) {
            return false;
        }

        const [box, project] = await Promise.all([
            context.db.get(boxId) as Promise<BoxRow | null>,
            context.db.get(deployment.projectId) as Promise<null | { boxId?: null | string; organizationId: string }>,
        ]);

        return (
            box !== null &&
            box.status !== "revoked" &&
            project?.boxId === boxId &&
            project.organizationId === box.organizationId &&
            deployment.organizationId === box.organizationId
        );
    });

/** A box a rollout targets: who it is and what it runs. */
export interface RolloutBox {
    boxId: Id<"boxes">;
    status: BoxStatus;
    versions?: BoxVersions;
}

/**
 * Point boxes at a stored `lunora-hostd` release (SYSTEM — the admin-token
 * rollout route): the named boxes, or every box that is not revoked. Revoked
 * boxes are never touched. Answers the boxes it set, for the rollout to plan.
 */
export const setDesiredRelease = internalMutation
    .input({ boxIds: v.optional(v.array(v.id("boxes"))), releaseId: boundedString(LIMITS.name) })
    .mutation(async ({ ctx: context, args: { boxIds, releaseId } }): Promise<RolloutBox[]> => {
        const { page: releases } = await context.db.hostdReleases.findMany({ where: { releaseId } });

        if (releases.length === 0) {
            throw new LunoraError("NOT_FOUND", `no stored hostd release ${releaseId}`);
        }

        const everyBox = boxIds === undefined ? await context.db.boxes.findMany({}) : undefined;
        const rows =
            everyBox === undefined
                ? ((await Promise.all((boxIds ?? []).map((id) => context.db.get(id)))) as (BoxRow | null)[]).filter((row): row is BoxRow => row !== null)
                : (everyBox.page as BoxRow[]);
        const targets = rows.filter((row) => row.status !== "revoked");

        for (const row of targets) {
            // eslint-disable-next-line no-await-in-loop -- one patch per box; a fleet rollout is an operator action
            await context.db.patch(row._id, { desiredReleaseId: releaseId });
        }

        return targets.map((row) => {
            return { boxId: row._id, status: row.status, ...(row.versions == null ? {} : { versions: row.versions }) };
        });
    });
