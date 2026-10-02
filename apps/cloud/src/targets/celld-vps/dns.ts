/**
 * A box's hostnames in the platform's own zone (plan 458 D9, G13):
 *
 * - `*.{slug}.{LUNORA_BOX_DOMAIN}` — every tenant on the box,
 *   `{alias}.{slug}.{LUNORA_BOX_DOMAIN}`;
 * - `{slug}.{LUNORA_BOX_DOMAIN}` — the box itself, which a custom domain
 *   CNAMEs to.
 *
 * Each gets an A record for the box's IPv4 and an AAAA record for its IPv6,
 * DNS-only, written at enrolment and removed at revocation. Both operations
 * are idempotent — they converge the zone on what the box row says, so a
 * retried enrolment or revocation is safe.
 *
 * The zone is the platform's own, not a tenant's: that is why this file may use
 * the Cloudflare REST port at all (the boundary fence in `eslint.config.js`).
 * The cell's `CLOUDFLARE_API_TOKEN` needs Zone → DNS:Edit on it.
 */
import type { CloudflareApi } from "../../cloudflare/api";
import { createHttpCloudflareApi } from "../../cloudflare/api";

/** Where a box's records live, and what they point at. */
export interface BoxDnsTarget {
    /** The apex (`LUNORA_BOX_DOMAIN`). */
    domain: string;
    ipv4?: string;
    ipv6?: string;
    slug: string;
    /** The zone holding `domain` (`LUNORA_BOX_ZONE_ID`). */
    zoneId: string;
}

const namesOf = (target: Pick<BoxDnsTarget, "domain" | "slug">): string[] => [`*.${target.slug}.${target.domain}`, `${target.slug}.${target.domain}`];

/** Make the zone hold exactly the box's A/AAAA records under its two names. */
export const syncBoxDns = async (api: CloudflareApi, target: BoxDnsTarget): Promise<void> => {
    const wanted: { content: string; type: "A" | "AAAA" }[] = [
        ...(target.ipv4 === undefined ? [] : [{ content: target.ipv4, type: "A" as const }]),
        ...(target.ipv6 === undefined ? [] : [{ content: target.ipv6, type: "AAAA" as const }]),
    ];

    for (const name of namesOf(target)) {
        // eslint-disable-next-line no-await-in-loop -- two names; sequential keeps the zone's write order obvious
        const listed = await api.listDnsRecords({ name, zoneId: target.zoneId });
        const existing = listed.filter((record) => record.type === "A" || record.type === "AAAA");

        for (const record of existing) {
            if (!wanted.some((want) => want.type === record.type && want.content === record.content)) {
                // eslint-disable-next-line no-await-in-loop -- a stale record per name, at most two
                await api.deleteDnsRecord({ id: record.id, zoneId: target.zoneId });
            }
        }

        for (const want of wanted) {
            if (!existing.some((record) => record.type === want.type && record.content === want.content)) {
                // eslint-disable-next-line no-await-in-loop -- one record per address family
                await api.createDnsRecord({ content: want.content, name, type: want.type, zoneId: target.zoneId });
            }
        }
    }
};

/** Remove every A/AAAA record under the box's two names. */
export const removeBoxDns = async (api: CloudflareApi, target: Pick<BoxDnsTarget, "domain" | "slug" | "zoneId">): Promise<void> => {
    for (const name of namesOf(target)) {
        // eslint-disable-next-line no-await-in-loop -- two names
        const existing = await api.listDnsRecords({ name, zoneId: target.zoneId });

        for (const record of existing.filter((candidate) => candidate.type === "A" || candidate.type === "AAAA")) {
            // eslint-disable-next-line no-await-in-loop -- at most two per name
            await api.deleteDnsRecord({ id: record.id, zoneId: target.zoneId });
        }
    }
};

/** The env slice box DNS reads. */
export type BoxDnsEnvironment = {
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
    LUNORA_BOX_DOMAIN?: string;
    /** The zone of `LUNORA_BOX_DOMAIN`; unset → boxes enrol without hostnames, and say so on their row. */
    LUNORA_BOX_ZONE_ID?: string;
};

/** The REST port and zone for box DNS, or why this control plane cannot write it. */
export const boxDnsFromEnv = (environment: BoxDnsEnvironment): { api: CloudflareApi; domain: string; zoneId: string } | { unavailable: string } => {
    if (!environment.LUNORA_BOX_ZONE_ID) {
        return { unavailable: "box DNS is not configured on this control plane (LUNORA_BOX_ZONE_ID is unset)" };
    }

    if (!environment.CLOUDFLARE_API_TOKEN) {
        return { unavailable: "box DNS needs CLOUDFLARE_API_TOKEN with Zone → DNS:Edit on the box zone" };
    }

    return {
        // The account id only prefixes account-scoped paths; DNS calls are zone-scoped.
        api: createHttpCloudflareApi({ accountId: environment.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: environment.CLOUDFLARE_API_TOKEN }),
        domain: environment.LUNORA_BOX_DOMAIN ?? "boxes.lunora.app",
        zoneId: environment.LUNORA_BOX_ZONE_ID,
    };
};
