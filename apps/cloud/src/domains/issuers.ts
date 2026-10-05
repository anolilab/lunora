/**
 * Which issuer holds a custom-domain certificate. A certificate is recorded
 * with the target that issued it and that target's issuer scope
 * (`domains.certificateIssuer` / `certificateScope`; `cloudflare-wfp`: its
 * SaaS zone), and every later read or release goes through THAT issuer — not
 * through the project's current target, which may have changed since, nor
 * through the first fleet that happens to issue certificates.
 */
import { LunoraError } from "@lunora/server";

import type { TargetId } from "../provision-contract";
import { storedTarget } from "../provision-contract";
import type { CertificateIssuer, TargetFleet } from "../targets/driver";

/** A certificate as a domain row (or a queued release) records it. `.global()` rows answer SQL NULL for an unset column. */
export interface RecordedCertificate {
    certificateIssuer?: null | string;
    certificateScope?: null | string;
}

/** A target's fleet on this control plane, or `undefined` for a target with no driver here. */
export type FleetLookup = (target: TargetId) => TargetFleet | undefined;

/**
 * The issuer holding `recorded` on this control plane, or `undefined` when it
 * is not one this control plane holds: no recorded issuer, a target with no
 * driver or no issuer here, or another scope (another cell's SaaS zone, which
 * that cell's control plane follows).
 */
export const localIssuer = (recorded: RecordedCertificate, fleetOf: FleetLookup): CertificateIssuer | undefined => {
    const target = recorded.certificateIssuer == null ? undefined : storedTarget(recorded.certificateIssuer);
    const issuer = target === undefined ? undefined : fleetOf(target)?.certificates;

    return issuer !== undefined && recorded.certificateScope != null && issuer.scope === recorded.certificateScope ? issuer : undefined;
};

/**
 * The issuer {@link localIssuer} finds, refusing a certificate this control plane cannot release.
 * @throws {LunoraError} `CONFLICT` naming the issuer it would need.
 */
export const requireIssuer = (recorded: RecordedCertificate, fleetOf: FleetLookup): CertificateIssuer => {
    const issuer = localIssuer(recorded, fleetOf);

    if (issuer === undefined) {
        throw new LunoraError(
            "CONFLICT",
            `its certificate was issued by ${recorded.certificateIssuer ?? "an unrecorded issuer"} (${recorded.certificateScope ?? "no scope"}), which this control plane cannot reach`,
        );
    }

    return issuer;
};
