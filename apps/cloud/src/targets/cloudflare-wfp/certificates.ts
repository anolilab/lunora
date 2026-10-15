/**
 * Custom-domain certificates on `cloudflare-wfp` (GAPS.md B1): Cloudflare for
 * SaaS custom hostnames on the platform's SaaS zone — the zone of
 * `LUNORA_APP_DOMAIN`, which custom domains CNAME to (`LUNORA_SAAS_ZONE_ID`).
 * Cloudflare issues and renews a DV certificate per hostname (HTTP
 * validation, so it needs nothing from the customer beyond the CNAME) and routes
 * the hostname's traffic into the zone, where the dispatcher serves it.
 *
 * A certificate is only ever requested for a hostname that already VERIFIED
 * (its TXT token and its CNAME — `POST /v1/domains/verify`), so nobody can make
 * the platform request certificates for hostnames they do not control
 * (Zeitwork's DB-gated on-demand TLS). Issuing re-reads the custom hostname
 * the domain row names and reuses nothing else — a hostname the zone holds for
 * another row (a removed domain's, still queued for release) is refused, never
 * adopted, so no two rows ever share a certificate and one release can never
 * pull it from under the other. Removing one that is gone is done.
 *
 * The zone is the platform's own, so this is the one place the `cloudflare-wfp`
 * driver uses the REST port (the boundary fence in `eslint.config.js`). The
 * cell's `CLOUDFLARE_API_TOKEN` needs Zone → SSL and Certificates:Edit on it.
 */
import { LunoraError } from "@lunora/server";

import type { CloudflareApi, CustomHostname } from "../../cloudflare/api";
import type { DomainCertificate } from "../driver";

/** Where custom hostnames live: the SaaS zone, over the REST port. */
export interface SaasZone {
    api: CloudflareApi;
    zoneId: string;
}

/** Longest certificate error kept on a domain row. */
export const MAX_CERTIFICATE_ERROR = 256;

/** The custom hostname's state as the domain row records it, scoped to the zone that holds it. */
export const certificateOf = (zone: SaasZone, hostname: CustomHostname): DomainCertificate => {
    const error = hostname.errors.join("; ").slice(0, MAX_CERTIFICATE_ERROR);

    return { customHostnameId: hostname.id, scope: zone.zoneId, sslStatus: hostname.sslStatus, ...(error === "" ? {} : { error }) };
};

/**
 * Request the certificate of a verified hostname, or re-read the one this row
 * created. A row that names its custom hostname is re-read; one whose hostname
 * vanished (deleted in the dashboard) gets a new one — unless the zone already
 * holds a custom hostname for that name which this row did not create.
 * @throws {LunoraError} `CONFLICT` when the zone holds another row's (or an outside) custom hostname for it.
 */
export const issueCertificate = async (zone: SaasZone, domain: { customHostnameId?: string; hostname: string }): Promise<DomainCertificate> => {
    const known = domain.customHostnameId === undefined ? null : await zone.api.getCustomHostname({ id: domain.customHostnameId, zoneId: zone.zoneId });

    if (known?.hostname === domain.hostname) {
        return certificateOf(zone, known);
    }

    const other = await zone.api.findCustomHostname({ hostname: domain.hostname, zoneId: zone.zoneId });

    if (other !== null) {
        throw new LunoraError(
            "CONFLICT",
            `the platform already holds a certificate for ${domain.hostname} that this domain did not request — most likely a removed domain's, which the hourly certificate sweep releases; verify again after it ran, and contact support if this persists`,
        );
    }

    return certificateOf(zone, await zone.api.createCustomHostname({ hostname: domain.hostname, zoneId: zone.zoneId }));
};

/** Re-read a certificate's status for the sweep; `null` once its custom hostname is gone. */
export const refreshCertificate = async (zone: SaasZone, customHostnameId: string): Promise<DomainCertificate | null> => {
    const hostname = await zone.api.getCustomHostname({ id: customHostnameId, zoneId: zone.zoneId });

    return hostname === null ? null : certificateOf(zone, hostname);
};

/** Delete a domain's custom hostname, and with it its certificate. Done when it is already gone. */
export const removeCertificate = async (zone: SaasZone, customHostnameId: string): Promise<void> => {
    await zone.api.deleteCustomHostname({ id: customHostnameId, zoneId: zone.zoneId });
};
