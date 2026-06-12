import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { SecurityAuditResult, SecurityFinding } from "./admin";
import { ADMIN_FUNCTIONS } from "./admin";
import type { AdvisorRow } from "./advisor-view";
import { AdvisorView } from "./advisor-view";
import type { TFunction } from "./i18n-context";
import { useT } from "./i18n-context";
import { adminRef, callOptions, errorMessage, fireAndForget } from "./internal";

const GET_SECURITY_AUDIT = adminRef(ADMIN_FUNCTIONS.getSecurityAudit);

/** Localized headline per finding kind, shown in the Issue type column. */
const findingTitle = (t: TFunction, finding: SecurityFinding): string =>
    ({
        "admin-token-weak": t("Weak admin token"),
        "dev-args-unredacted": t("Request log keeps un-redacted args"),
        "ws-gate-open": t("Live admin subscriptions are ungated"),
    })[finding.kind];

/** The env binding each finding concerns, shown in the Entity column. */
const findingEntity = (finding: SecurityFinding): string =>
    ({ "admin-token-weak": "CIRRUS_ADMIN_TOKEN", "dev-args-unredacted": "request log", "ws-gate-open": "CIRRUS_WS_BEARER" })[finding.kind];

/** Localized one-line explanation + remediation per finding kind. `admin-token-weak` interpolates the offending length. */
const findingDetail = (t: TFunction, finding: SecurityFinding): string =>
    ({
        "admin-token-weak": t("Your admin token is {length} characters — use at least {min} for a brute-force-resistant secret.", {
            length: finding.detail?.["length"],
            min: finding.detail?.["min"],
        }),
        "dev-args-unredacted": t(
            "This worker reports a development environment, so the request log stores raw args and identity. Confirm it isn't a mislabeled production deploy.",
        ),
        "ws-gate-open": t(
            "CIRRUS_WS_BEARER is unset, so the WebSocket upgrade gate is open: live admin subscriptions need no credential. Set it to gate them like the HTTP admin RPCs.",
        ),
    })[finding.kind];

/**
 * The Security Advisor — a 1-to-1 of Supabase's Security Advisor: severity tabs
 * (Errors / Warnings / Info) over a findings table. It pulls `getSecurityAudit`
 * (deployment-wide, so it targets the root shard and needs no shard selector) and
 * maps each finding the server derived from the Worker `env` — weak admin token,
 * an open WebSocket gate, a dev-mode request log keeping un-redacted args — into a
 * row. These are signals only cirrus can surface: Cloudflare's dashboard can't
 * reason about cirrus's admin/WS gates or its log-redaction policy.
 */
const SecurityAdvisorPanel = (): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [findings, setFindings] = useState<SecurityFinding[] | null>(null);
    const [error, setError] = useState<null | string>(null);

    const refresh = useCallback(async (): Promise<void> => {
        try {
            const result = (await client.query(GET_SECURITY_AUDIT, {}, callOptions(""))) as SecurityAuditResult;

            // Defensive: an older worker (or a stand-in) may not return a findings
            // array — treat anything but an array as "no findings" rather than throw.
            setFindings(Array.isArray(result.findings) ? result.findings : []);
            setError(null);
        } catch (error_: unknown) {
            setError(errorMessage(error_));
        }
    }, [client]);

    useEffect(() => {
        fireAndForget(refresh());
    }, [refresh]);

    const rows = useMemo<AdvisorRow[] | null>(
        () =>
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
                  }),
        [findings, t],
    );

    return <AdvisorView error={error} rows={rows} testId="cirrus-security-advisor" />;
};

export default SecurityAdvisorPanel;
