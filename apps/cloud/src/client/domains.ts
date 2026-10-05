import type { ReturnOf } from "@lunora/client";

import type { api } from "../../lunora/_generated/api.js";

/**
 * Pure helpers for the Domains tab (GAPS.md B1): how a verified domain's
 * certificate reads. Kept out of the component so each state is testable in
 * node, without a DOM.
 */

export type DomainView = ReturnOf<typeof api.domains.list>[number];

/** The status-chip tones `StatusBadge` knows. */
type Tone = "danger" | "neutral" | "success" | "warning";

/** How a certificate's state reads: its chip, and the sentence under the row when there is something to say. */
export interface CertificateBadge {
    detail?: string;
    label: string;
    tone: Tone;
}

/** The issuer's statuses on the way to `active` (Cloudflare for SaaS `ssl.status`). */
const PENDING = new Set(["initializing", "pending_deployment", "pending_issuance", "pending_validation"]);

/**
 * A verified domain's certificate, or `null` when there is nothing to show: an
 * unverified domain (no certificate is ever requested before it verifies), or
 * one whose target terminates TLS itself and records none (a box).
 */
export const certificateBadge = (domain: Pick<DomainView, "certificateError" | "certificateStatus" | "verifiedAt">): CertificateBadge | null => {
    const status = domain.certificateStatus ?? undefined;

    if (domain.verifiedAt == null || status === undefined) {
        return null;
    }

    const detail = domain.certificateError ?? undefined;

    if (status === "active") {
        return { label: "certificate active", tone: "success" };
    }

    if (PENDING.has(status)) {
        return {
            detail: detail ?? "Cloudflare is validating and issuing the certificate; this takes a few minutes, sometimes longer. The page updates on its own.",
            label: "certificate pending",
            tone: "warning",
        };
    }

    if (status === "unconfigured") {
        return { detail: detail ?? "This control plane cannot request certificates.", label: "no certificate", tone: "neutral" };
    }

    return {
        detail: detail ?? `The certificate is ${status.replaceAll("_", " ")}. Verify the domain again to retry.`,
        label: "certificate error",
        tone: "danger",
    };
};
