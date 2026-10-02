/**
 * The hourly custom-domain certificate sweep (GAPS.md B1): a certificate is
 * requested when its domain verifies (the target driver's `domains.onVerified`),
 * and then takes minutes to hours to validate, issue and deploy. Until it is
 * `active`, this re-reads each one through the fleet that issued it
 * (`TargetFleet.refreshCertificate`) and records what the issuer says, so the
 * studio's domains tab shows where it stands without anyone pressing Verify
 * again.
 *
 * Target-neutral: it only follows `customHostnameId`s a driver already wrote.
 * Bounded — {@link MAX_CERTIFICATES_PER_TICK} reads a tick, oldest checked
 * first — and a failed read leaves the row as it was for the next tick.
 */
import type { ControlPlaneStore } from "../d1-store";
import type { DomainCertificate } from "../targets/driver";

/** Certificates re-read per tick, so a backlog cannot turn one tick into thousands of API calls. */
export const MAX_CERTIFICATES_PER_TICK = 50;

/** The certificate status that ends the sweep's interest in a domain. */
const ISSUED = "active";

interface DomainRow {
    _id: string;
    certificateStatus?: null | string;
    customHostnameId?: null | string;
    updatedAt: number;
    verifiedAt?: null | number;
}

export interface CertificateSweepPorts {
    database: ControlPlaneStore;
    log?: (line: string) => void;
    now: number;
    /** The issuing fleet's `refreshCertificate`; `null` once the certificate is gone. */
    refresh: (customHostnameId: string) => Promise<DomainCertificate | null>;
}

/** What a tick did. */
export interface CertificateSweepResult {
    checked: number;
    failed: number;
    issued: number;
}

/** Re-read the certificates of verified domains that are not issued yet, and record what changed. */
export const runCertificateSweep = async (ports: CertificateSweepPorts): Promise<CertificateSweepResult> => {
    const { page } = await ports.database.findMany("domains", {});
    const due = (page as DomainRow[])
        .filter((row) => row.verifiedAt != null && row.customHostnameId != null && row.certificateStatus !== ISSUED)
        .toSorted((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, MAX_CERTIFICATES_PER_TICK);
    const result: CertificateSweepResult = { checked: 0, failed: 0, issued: 0 };

    for (const row of due) {
        result.checked += 1;

        try {
            // eslint-disable-next-line no-await-in-loop -- bounded batch; one API read at a time keeps the cell's API budget flat
            const certificate = await ports.refresh(row.customHostnameId as string);
            // A vanished custom hostname is forgotten, so the sweep stops reading it; verifying again requests a new one.
            const patch =
                certificate === null
                    ? {
                          certificateError: "the certificate's custom hostname no longer exists; verify the domain again to request a new one",
                          certificateStatus: "missing",
                          customHostnameId: null,
                      }
                    : { certificateError: certificate.error ?? null, certificateStatus: certificate.sslStatus };

            // eslint-disable-next-line no-await-in-loop -- one row per certificate read
            await ports.database.patch(row._id, { ...patch, updatedAt: ports.now }, "domains");

            if (certificate?.sslStatus === ISSUED) {
                result.issued += 1;
            }
        } catch (error) {
            result.failed += 1;
            ports.log?.(`[certificates] could not refresh domain ${row._id}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return result;
};
