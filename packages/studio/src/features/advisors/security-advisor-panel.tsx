import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import type { TFunction } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";
import type { SecurityAuditResult, SecurityFinding } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../lib/internal";
import { AdvisorView } from "./advisor-view";

const GET_SECURITY_AUDIT = adminRef(ADMIN_FUNCTIONS.getSecurityAudit);

/** Localized headline per finding kind, shown in the Issue type column. */
const findingTitle = (t: TFunction, finding: SecurityFinding): string =>
    ({
        "admin-token-weak": t("Weak admin token"),
        "auth-secret-weak": t("Weak auth secret"),
        "cookies-insecure": t("Session cookies are not Secure"),
        "cors-wildcard-credentials": t("Wildcard CORS with credentials"),
        "csrf-disabled": t("CSRF/origin guard is off"),
        "dev-args-unredacted": t("Request log keeps un-redacted args"),
        "security-headers-disabled": t("Security headers are off"),
        "ws-gate-open": t("Live admin subscriptions are ungated"),
    })[finding.kind];

/** The env binding each finding concerns, shown in the Entity column. */
const findingEntity = (finding: SecurityFinding): string =>
    ({
        "admin-token-weak": "LUNORA_ADMIN_TOKEN",
        "auth-secret-weak": "AUTH_SECRET",
        "cookies-insecure": "BETTER_AUTH_URL",
        "cors-wildcard-credentials": "LUNORA_ALLOWED_ORIGINS",
        "csrf-disabled": "LUNORA_SECURITY_CSRF",
        "dev-args-unredacted": "request log",
        "security-headers-disabled": "LUNORA_SECURITY_HEADERS",
        "ws-gate-open": "LUNORA_WS_BEARER",
    })[finding.kind];

/** Localized one-line explanation + remediation per finding kind. `admin-token-weak`/`auth-secret-weak` interpolate the offending length. */
const findingDetail = (t: TFunction, finding: SecurityFinding): string =>
    ({
        "admin-token-weak": t("Your admin token is {length} characters — use at least {min} for a brute-force-resistant secret.", {
            length: finding.detail?.["length"],
            min: finding.detail?.["min"],
        }),
        "auth-secret-weak": t("Your auth secret is {length} characters — use at least {min} (e.g. `openssl rand -hex 32`) to sign sessions safely.", {
            length: finding.detail?.["length"],
            min: finding.detail?.["min"],
        }),
        "cookies-insecure": t(
            "BETTER_AUTH_URL is a plaintext http:// origin, so session cookies cannot be Secure and ride in cleartext. Serve auth over https:// in production.",
        ),
        "cors-wildcard-credentials": t(
            "LUNORA_ALLOWED_ORIGINS includes a wildcard while credentials are allowed — browsers reject this and it defeats the allowlist. Name explicit origins instead of *.",
        ),
        "csrf-disabled": t(
            "LUNORA_SECURITY_CSRF is off, so cross-origin state-changing cookie requests are not blocked. Re-enable it in production to keep mutations un-forgeable.",
        ),
        "dev-args-unredacted": t(
            "This worker reports a development environment, so the request log stores raw args and identity. Confirm it isn't a mislabeled production deploy.",
        ),
        "security-headers-disabled": t(
            "LUNORA_SECURITY_HEADERS is off, so HSTS, CSP, nosniff, and frame-options are not applied. Re-enable the baseline headers in production.",
        ),
        "ws-gate-open": t(
            "LUNORA_WS_BEARER is unset, so the WebSocket upgrade gate is open: live admin subscriptions need no credential. Set it to gate them like the HTTP admin RPCs.",
        ),
    })[finding.kind];

/**
 * The Security Advisor — a 1-to-1 of Supabase's Security Advisor: severity tabs
 * (Errors / Warnings / Info) over a findings table. It pulls `getSecurityAudit`
 * (deployment-wide, so it targets the root shard and needs no shard selector) and
 * maps each finding the server derived from the Worker `env` — weak admin token,
 * an open WebSocket gate, a dev-mode request log keeping un-redacted args — into a
 * row. These are signals only lunora can surface: Cloudflare's dashboard can't
 * reason about lunora's admin/WS gates or its log-redaction policy.
 */
const SecurityAdvisorPanel = (): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [findings, setFindings] = useState<SecurityFinding[] | null>(null);
    const [error, setError] = useState<null | string>(null);

    const refresh = async (): Promise<void> => {
        try {
            const result = (await client.query(GET_SECURITY_AUDIT, {}, callOptions(""))) as SecurityAuditResult;

            // Defensive: an older worker (or a stand-in) may not return a findings
            // array — treat anything but an array as "no findings" rather than throw.
            setFindings(Array.isArray(result.findings) ? result.findings : []);
            setError(null);
        } catch (error_: unknown) {
            setError(errorMessage(error_));
        }
    };

    useEffect(() => {
        fireAndForget(refresh());
    }, [refresh]);

    const rows =
        findings === null
            ? null
            : findings.map((finding) => {
                  return {
                      description: findingDetail(t, finding),
                      entity: findingEntity(finding),
                      issueType: findingTitle(t, finding),
                      key: finding.kind,
                      level: finding.level,
                  };
              });

    return <AdvisorView error={error} rows={rows} testId="lunora-security-advisor" />;
};

export default SecurityAdvisorPanel;
