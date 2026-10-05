/**
 * The hourly custom-domain certificate sweep (GAPS.md B1): a certificate is
 * requested when its domain verifies (the target driver's `domains.issue`),
 * and then takes minutes to hours to validate, issue and deploy. Until it is
 * `active`, this re-reads each one through the issuer recorded with it
 * (`certificateIssuer` / `certificateScope`, `src/domains/issuers.ts`) and
 * records what the issuer says, so the studio's domains tab shows where it
 * stands without anyone pressing Verify again.
 *
 * Target-neutral: it only follows `customHostnameId`s a driver already wrote,
 * each through its own issuer — a certificate whose issuer this control plane
 * does not hold (another cell's zone) is left to the one that does. Bounded —
 * {@link MAX_CERTIFICATES_PER_TICK} reads a tick, oldest checked first — and a
 * failed read leaves the row as it was for the next tick.
 *
 * It also drains `certificateReleases` first: the certificates of domains whose
 * project was deleted or organization purged, which a mutation could only queue.
 * Each is released through its recorded issuer and then forgotten; a failed
 * release stays queued with its error for the next tick.
 */
import type { ControlPlaneStore } from "../d1-store";
import type { CertificateIssuer } from "../targets/driver";
import type { RecordedCertificate } from "./issuers";

/** Certificates re-read per tick, so a backlog cannot turn one tick into thousands of API calls. */
export const MAX_CERTIFICATES_PER_TICK = 50;

/** Queued certificates released per tick, for the same reason. */
export const MAX_RELEASES_PER_TICK = 50;

/** Longest release error kept on a queued row. */
const MAX_RELEASE_ERROR = 256;

/** The certificate status that ends the sweep's interest in a domain. */
const ISSUED = "active";

interface QueuedRelease {
    _id: string;
    attempts?: null | number;
    certificateIssuer: string;
    certificateScope: string;
    customHostnameId: string;
    hostname: string;
    queuedAt: number;
}

interface DomainRow extends RecordedCertificate {
    _id: string;
    certificateStatus?: null | string;
    customHostnameId?: null | string;
    updatedAt: number;
    verifiedAt?: null | number;
}

export interface CertificateSweepPorts {
    database: ControlPlaneStore;
    /** The issuer holding a recorded certificate here (`localIssuer`), or `undefined` when this control plane holds none for it. */
    issuerOf: (recorded: RecordedCertificate) => CertificateIssuer | undefined;
    log?: (line: string) => void;
    now: number;
}

/** What a tick did. */
export interface CertificateSweepResult {
    checked: number;
    failed: number;
    issued: number;
    /** Queued certificates of deleted domains released (and forgotten). */
    released: number;
    /** Queued releases that failed, kept for the next tick. */
    releaseFailed: number;
}

/** Release queued certificates through their recorded issuers, forgetting each once it is released. */
const drainReleases = async (ports: CertificateSweepPorts): Promise<Pick<CertificateSweepResult, "released" | "releaseFailed">> => {
    const result = { released: 0, releaseFailed: 0 };

    const { page } = await ports.database.findMany("certificateReleases", {});
    const due = (page as QueuedRelease[])
        .flatMap((row) => {
            const issuer = ports.issuerOf(row);

            return issuer === undefined ? [] : [{ issuer, row }];
        })
        .toSorted((a, b) => a.row.queuedAt - b.row.queuedAt)
        .slice(0, MAX_RELEASES_PER_TICK);

    for (const { issuer, row } of due) {
        try {
            // eslint-disable-next-line no-await-in-loop -- bounded batch; one API call at a time keeps the cell's API budget flat
            await issuer.release(row.customHostnameId);
            // eslint-disable-next-line no-await-in-loop -- forgotten only once released
            await ports.database.delete(row._id, "certificateReleases");
            result.released += 1;
        } catch (error) {
            const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_RELEASE_ERROR);

            result.releaseFailed += 1;
            ports.log?.(`[certificates] could not release the certificate of ${row.hostname}: ${message}`);
            // eslint-disable-next-line no-await-in-loop -- one row per failed release
            await ports.database.patch(row._id, { attempts: (row.attempts ?? 0) + 1, lastError: message }, "certificateReleases").catch(() => undefined);
        }
    }

    return result;
};

/** Release the queued certificates of deleted domains, then re-read the certificates of verified domains that are not issued yet, and record what changed. */
export const runCertificateSweep = async (ports: CertificateSweepPorts): Promise<CertificateSweepResult> => {
    const result: CertificateSweepResult = { checked: 0, failed: 0, issued: 0, ...(await drainReleases(ports)) };

    const { page } = await ports.database.findMany("domains", {});
    const due = (page as DomainRow[])
        .filter((row) => row.verifiedAt != null && row.customHostnameId != null && row.certificateStatus !== ISSUED)
        .flatMap((row) => {
            const issuer = ports.issuerOf(row);

            return issuer === undefined ? [] : [{ issuer, row }];
        })
        .toSorted((a, b) => a.row.updatedAt - b.row.updatedAt)
        .slice(0, MAX_CERTIFICATES_PER_TICK);

    for (const { issuer, row } of due) {
        result.checked += 1;

        try {
            // eslint-disable-next-line no-await-in-loop -- bounded batch; one API read at a time keeps the cell's API budget flat
            const certificate = await issuer.refresh(row.customHostnameId as string);
            // A vanished custom hostname is forgotten, so the sweep stops reading it; verifying again requests a new one.
            const patch =
                certificate === null
                    ? {
                          certificateError: "the certificate's custom hostname no longer exists; verify the domain again to request a new one",
                          certificateIssuer: null,
                          certificateScope: null,
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
