import { LunoraError } from "@lunora/server";

import { randomSecret } from "../src/deploy/keys";
import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg } from "./authz";

/**
 * Custom domains (GAPS.md B1). A hostname is added (minting a TXT verification
 * token), verified by the edge (`POST /v1/domains/verify` does the DNS lookups
 * via `src/domains/verify.ts`, then calls {@link markVerified}), and routed by
 * the dispatcher through {@link routeForHostname}. Cert issuance (Cloudflare
 * for SaaS) is only requested for verified rows.
 */

interface DomainRow {
    _id: Id<"domains">;
    createdAt: number;
    customHostnameId?: string;
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
export const add = mutation
    .input({
        hostname: v.string(),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
        redirectStatusCode: v.optional(v.number()),
        redirectTo: v.optional(v.string()),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<{ id: Id<"domains">; txtName: string; txtToken: string }> => {
        await assertMember(context, arguments_.organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, arguments_.projectId, arguments_.organizationId, "project");

        const hostname = arguments_.hostname.toLowerCase().trim();

        if (!HOSTNAME_PATTERN.test(hostname)) {
            throw new LunoraError("BAD_REQUEST", "not a valid hostname");
        }

        const txtToken = randomSecret();
        const now = Date.now();
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

/** Remove a domain (owner/admin). */
export const remove = mutation
    .input({ id: v.id("domains"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, organizationId } }): Promise<void> => {
        await assertMember(context, organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, id, organizationId, "domain");

        await context.db.delete(id);
    });

/**
 * Record a verification outcome (member-called via the edge verify route,
 * which performs the actual DNS lookups). Also stores the Cloudflare custom-
 * hostname id once the 🌐 provisioning path creates it.
 */
export const markVerified = mutation
    .input({ customHostnameId: v.optional(v.string()), id: v.id("domains"), organizationId: v.id("organizations"), verified: v.boolean() })
    .mutation(async ({ ctx: context, args: { customHostnameId, id, organizationId, verified } }): Promise<void> => {
        await assertMember(context, organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, id, organizationId, "domain");

        await context.db.patch(id, {
            ...(customHostnameId === undefined ? {} : { customHostnameId }),
            updatedAt: Date.now(),
            verifiedAt: verified ? Date.now() : undefined,
        });
    });

/**
 * Resolve a verified custom hostname for the dispatcher: either a redirect
 * instruction or the owning project's active script. Public + unauthenticated
 * like `deployments.planForScript` (non-sensitive routing data); reached
 * through a bearer-gated control-plane endpoint. Unverified rows never route.
 */
export const routeForHostname = query
    .input({ hostname: v.string() })
    .query(async ({ ctx: context, args: { hostname } }): Promise<null | { redirectStatusCode?: number; redirectTo?: string; scriptName?: string }> => {
        const { page } = await context.db.domains.findMany({ where: { hostname: hostname.toLowerCase() } });
        const domain = (page as unknown as DomainRow[])[0];

        if (domain?.verifiedAt === undefined) {
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
