import { LunoraError } from "@lunora/server";

import { randomSecret } from "../src/deploy/keys";
import type { TargetId } from "../src/provision-contract";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext } from "./_generated/server.js";
import { internalMutation, internalQuery, mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg } from "./authz";
import { orgEntitlements } from "./entitlements";
import { rateLimit } from "./guards";
import { deployTarget } from "./tables/shared";
import { boundedString, LIMITS } from "./validators";

/**
 * Custom domains (GAPS.md B1). A hostname is added (minting a TXT verification
 * token), verified by the edge (`POST /v1/domains/verify` does the DNS lookups
 * via `src/domains/verify.ts`, then calls {@link markVerified}), and routed by
 * the dispatcher through {@link routeForHostname}. Its certificate is requested
 * by the project's target driver once it verified (`DomainOps.issue`;
 * Cloudflare for SaaS on `cloudflare-wfp`) and recorded with its issuer by
 * {@link recordCertificate}; removing a domain (`POST /v1/domains/remove`)
 * releases it first, through that issuer.
 */

interface DomainRow {
    _id: Id<"domains">;
    certificateError?: null | string;
    certificateIssuer?: null | TargetId;
    certificateScope?: null | string;
    certificateStatus?: null | string;
    createdAt: number;
    customHostnameId?: null | string;
    hostname: string;
    organizationId: Id<"organizations">;
    projectId: Id<"projects">;
    redirectStatusCode?: number;
    redirectTo?: string;
    txtToken: string;
    updatedAt: number;
    verifiedAt?: number;
}

interface ProjectRow {
    _id: Id<"projects">;
    activeScriptName?: string;
}

const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

/** Add a hostname to a project (owner/admin) and mint its TXT verification token. */
/** Whether a redirect target is an absolute http(s) URL — the only form the dispatcher may echo as a `Location`. */
const isRedirectTarget = (value: string): boolean => {
    try {
        const { protocol } = new URL(value);

        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
};

export const add = mutation
    .use(rateLimit("provision"))
    .input({
        hostname: boundedString(LIMITS.hostname),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
        redirectStatusCode: v.optional(v.number()),
        redirectTo: v.optional(boundedString(LIMITS.url)),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<{ id: Id<"domains">; txtName: string; txtToken: string }> => {
        const member = await assertMember(context, arguments_.organizationId, ["owner", "admin"]);

        await assertRowInOrg(context, arguments_.projectId, arguments_.organizationId, "project");

        // Custom domains are a plan feature (GAPS.md B1) — enforce the
        // entitlement, not just the flag on the pricing page.
        const entitlements = await orgEntitlements(context, arguments_.organizationId);

        if (!entitlements.has("customDomains")) {
            throw new LunoraError("FORBIDDEN", "custom domains require a plan with the customDomains feature");
        }

        const hostname = arguments_.hostname.toLowerCase().trim();

        if (!HOSTNAME_PATTERN.test(hostname)) {
            throw new LunoraError("BAD_REQUEST", "not a valid hostname");
        }

        // `redirectTo` is echoed to the eyeball as a 308 `Location` by the
        // dispatcher, so an unvalidated value turns a custom domain into an open
        // redirect pointing anywhere — including `javascript:` in clients that
        // still honour it. Only absolute http(s) targets are accepted.
        if (arguments_.redirectTo !== undefined && !isRedirectTarget(arguments_.redirectTo)) {
            throw new LunoraError("BAD_REQUEST", "redirectTo must be an absolute http(s) URL");
        }

        const txtToken = randomSecret();
        const { now } = context;
        const id = await context.db.insert("domains", {
            createdAt: now,
            hostname,
            organizationId: arguments_.organizationId,
            projectId: arguments_.projectId, // secret-scanner:allow -- domain field name
            ...(arguments_.redirectStatusCode === undefined ? {} : { redirectStatusCode: arguments_.redirectStatusCode }),
            ...(arguments_.redirectTo === undefined ? {} : { redirectTo: arguments_.redirectTo }),
            txtToken,
            updatedAt: now,
        });

        await context.db.insert("auditLog", {
            action: "domain.add",
            actorUserId: member.userId,
            createdAt: now,
            organizationId: arguments_.organizationId,
            target: hostname,
        });

        return { id, txtName: `_lunora.${hostname}`, txtToken };
    });

/** A project's domains (members). */
export const list = query
    .input({ organizationId: v.id("organizations"), projectId: v.id("projects") })
    .query(async ({ ctx: context, args: { organizationId, projectId } }): Promise<DomainRow[]> => {
        await assertMember(context, organizationId);
        await assertRowInOrg(context, projectId, organizationId, "project");

        const { page } = await context.db.domains.findMany({ where: { organizationId, projectId } });

        return page;
    });

/**
 * What removing a domain must release first (owner/admin, under the caller's
 * session): its hostname, project and the certificate an issuer holds for it,
 * with that issuer. SYSTEM
 * only — `POST /v1/domains/remove` asks before it deletes the certificate, so a
 * caller who may not remove the domain cannot delete its certificate either.
 */
export const removalTarget = internalQuery
    .input({ id: v.id("domains"), organizationId: v.id("organizations") })
    .query(
        async ({
            ctx: context,
            args: { id, organizationId },
        }): Promise<{ certificateIssuer?: TargetId; certificateScope?: string; customHostnameId?: string; hostname: string; projectId: Id<"projects"> }> => {
            await assertMember(context, organizationId, ["owner", "admin"]);
            await assertRowInOrg(context, id, organizationId, "domain");

            const domain = (await context.db.get(id)) as DomainRow;

            return {
                ...(domain.certificateIssuer == null ? {} : { certificateIssuer: domain.certificateIssuer }),
                ...(domain.certificateScope == null ? {} : { certificateScope: domain.certificateScope }),
                ...(domain.customHostnameId == null ? {} : { customHostnameId: domain.customHostnameId }),
                hostname: domain.hostname,
                projectId: domain.projectId, // secret-scanner:allow -- domain field name
            };
        },
    );

/**
 * Remove a domain (owner/admin). Internal: only `POST /v1/domains/remove` calls
 * it, once the project's target released the domain's certificate — removed any
 * other way, a Cloudflare-for-SaaS custom hostname would outlive its row.
 */
export const remove = internalMutation
    .use(rateLimit("api"))
    .input({ id: v.id("domains"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, organizationId } }): Promise<void> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);

        await assertRowInOrg(context, id, organizationId, "domain");

        const domain = (await context.db.get(id)) as DomainRow | null;

        await context.db.delete(id);
        await context.db.insert("auditLog", {
            action: "domain.remove",
            actorUserId: member.userId,
            createdAt: context.now,
            organizationId,
            target: domain?.hostname,
        });
    });

/**
 * Queue the certificates of the domains matching `where` for release, ahead of
 * deleting those domain rows (`projects.remove`, `organizations.purgeDeleted`).
 * A mutation cannot reach the issuer, and deleting the row alone would orphan
 * the certificate — still routing its hostname, and billed per hostname — with
 * nothing left that names it. The hourly certificate sweep releases each
 * through the issuer recorded with it, then forgets it.
 */
export const queueCertificateReleases = async (
    context: MutationContext,
    where: { organizationId: Id<"organizations"> } | { projectId: Id<"projects"> },
): Promise<void> => {
    const { page } = await context.db.domains.findMany({ where });

    for (const domain of page) {
        if (domain.customHostnameId != null && domain.certificateIssuer != null && domain.certificateScope != null) {
            // eslint-disable-next-line no-await-in-loop -- one scope's domains are few
            await context.db.insert("certificateReleases", {
                certificateIssuer: domain.certificateIssuer,
                certificateScope: domain.certificateScope,
                customHostnameId: domain.customHostnameId,
                hostname: domain.hostname,
                queuedAt: context.now,
            });
        }
    }
};

/**
 * Record a verification outcome. SYSTEM only — dispatched by the edge verify
 * route, which performs the DNS lookups whose result this stores. A certificate
 * is recorded by {@link recordCertificate}, with its issuer, never here.
 *
 * **`internalMutation`, and that is the whole security property.** This was a
 * public mutation taking `verified` as a caller-supplied boolean, so the DNS
 * proof in the edge route was decorative: anyone who could reach RPC could skip
 * the route and assert their own verification. Combined with `add` — which
 * validates hostname SYNTAX only — and the globally unique `by_hostname` index,
 * an owner/admin of any entitled org could claim a hostname they do not own,
 * permanently lock its real owner out of the platform, mark it verified, and have
 * `routeForHostname` serve their script (or a redirect to anywhere) for traffic
 * arriving on it.
 *
 * The org check still runs, because an internal function is only as scoped as its
 * caller: the route passes the caller's `organizationId` and this confirms the
 * domain row belongs to it.
 */
export const markVerified = internalMutation
    .input({
        id: v.id("domains"),
        organizationId: v.id("organizations"),
        verified: v.boolean(),
    })
    .mutation(async ({ ctx: context, args: { id, organizationId, verified } }): Promise<void> => {
        await assertRowInOrg(context, id, organizationId, "domain");

        await context.db.patch(id, {
            updatedAt: context.now,
            // `null`, not `undefined`: the store refuses an explicitly-undefined patch
            // outright, so a FAILED re-verification threw instead of clearing the stamp.
            verifiedAt: verified ? context.now : null,
        });
    });

/**
 * Record a domain's certificate as its target reported it (SYSTEM — the verify
 * route, after the driver's `issue`). An issued certificate is recorded with
 * the target that issued it and its issuer scope, which every later refresh
 * and release goes through; it is kept once known. A missing `error` clears an
 * earlier one.
 */
export const recordCertificate = internalMutation
    .input({
        customHostnameId: v.optional(boundedString(LIMITS.id)),
        error: v.optional(boundedString(LIMITS.token)),
        id: v.id("domains"),
        issuer: v.optional(deployTarget),
        organizationId: v.id("organizations"),
        scope: v.optional(boundedString(LIMITS.id)),
        sslStatus: boundedString(LIMITS.name),
    })
    .mutation(async ({ ctx: context, args: { customHostnameId, error, id, issuer, organizationId, scope, sslStatus } }): Promise<void> => {
        await assertRowInOrg(context, id, organizationId, "domain");

        if (customHostnameId !== undefined && (issuer === undefined || scope === undefined)) {
            throw new LunoraError("BAD_REQUEST", "an issued certificate is recorded with its issuer and scope");
        }

        await context.db.patch(id, {
            certificateError: error ?? null,
            certificateStatus: sslStatus,
            ...(customHostnameId === undefined || issuer === undefined || scope === undefined
                ? {}
                : { certificateIssuer: issuer, certificateScope: scope, customHostnameId }),
            updatedAt: context.now,
        });
    });

/**
 * Resolve a verified custom hostname for the dispatcher: either a redirect
 * instruction or the owning project's active script. Public + unauthenticated
 * like `deployments.planForScript` (non-sensitive routing data); reached
 * through a bearer-gated control-plane endpoint. Unverified rows never route.
 */
export const routeForHostname = query
    .input({ hostname: boundedString(LIMITS.hostname) })
    .query(async ({ ctx: context, args: { hostname } }): Promise<null | { redirectStatusCode?: number; redirectTo?: string; scriptName?: string }> => {
        const { page } = await context.db.domains.findMany({ where: { hostname: hostname.toLowerCase().trim() } });
        const domain = page[0];

        if (domain?.verifiedAt == null) {
            return null;
        }

        if (domain.redirectTo) {
            return { redirectStatusCode: domain.redirectStatusCode ?? 308, redirectTo: domain.redirectTo };
        }

        const project = (await context.db.get(domain.projectId)) as ProjectRow | null;

        return project?.activeScriptName ? { scriptName: project.activeScriptName } : null;
    });

/** A single domain row (members) — the edge verify route reads the TXT token through this. */
export const get = query
    .input({ id: v.id("domains"), organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { id, organizationId } }): Promise<DomainRow | null> => {
        await assertMember(context, organizationId);

        const domain = (await context.db.get(id)) as DomainRow | null;

        return domain?.organizationId === organizationId ? domain : null;
    });
