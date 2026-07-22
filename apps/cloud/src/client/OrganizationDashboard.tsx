import { useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useMemo, useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { ActivitySection } from "./ActivitySection";
import { AlertsSection } from "./AlertsSection";
import { BillingSection } from "./BillingSection";
import { BuildsSection } from "./BuildsSection";
import { CommandPalette } from "./CommandPalette";
import { DashboardsSection } from "./DashboardsSection";
import { DeployKeysSection } from "./DeployKeysSection";
import { DomainsSection } from "./DomainsSection";
import { IncidentsSection } from "./IncidentsSection";
import { InvitationsSection } from "./InvitationsSection";
import { IssuesSection } from "./IssuesSection";
import { LogsSection } from "./LogsSection";
import { MembersSection } from "./MembersSection";
import { MetricsSection } from "./MetricsSection";
import { ProjectsSection } from "./ProjectsSection";
import { SecretsSection } from "./SecretsSection";
import { TimeRangeProvider } from "./TimeRangeProvider";
import { TracesSection } from "./TracesSection";
import type { OrgId } from "./types";
import { UptimeSection } from "./UptimeSection";
import { UsageSection } from "./UsageSection";
import type { PaletteCommand } from "./use-command-palette";
import { useCommandPalette } from "./use-command-palette";

interface OrganizationDashboardProps {
    onBack: () => void;
    organizationId: OrgId;
}

type Tab =
    | "activity"
    | "alerts"
    | "billing"
    | "builds"
    | "dashboards"
    | "domains"
    | "incidents"
    | "invitations"
    | "issues"
    | "keys"
    | "logs"
    | "members"
    | "metrics"
    | "projects"
    | "secrets"
    | "traces"
    | "uptime"
    | "usage";

/**
 * Props every section receives. Beyond `organizationId`, sections may use
 * `openTab` to deep-link to another tab (e.g. an Issue → its trace), and
 * `focusTraceId` — the trace/trace-filter the target tab should open on.
 */
export interface SectionProps {
    focusTraceId?: string;
    onOpenTab?: (tab: "logs" | "traces", context?: { traceId?: string }) => void;
    organizationId: OrgId;
}

const TABS: { id: Tab; label: string }[] = [
    { id: "projects", label: "Projects" },
    { id: "members", label: "Members" },
    { id: "keys", label: "Deploy keys" },
    { id: "secrets", label: "Secrets" },
    { id: "domains", label: "Domains" },
    { id: "builds", label: "Builds" },
    { id: "logs", label: "Logs" },
    { id: "traces", label: "Traces" },
    { id: "metrics", label: "Metrics" },
    { id: "dashboards", label: "Dashboards" },
    { id: "issues", label: "Issues" },
    { id: "incidents", label: "Incidents" },
    { id: "uptime", label: "Uptime" },
    { id: "alerts", label: "Alerts" },
    { id: "invitations", label: "Invitations" },
    { id: "usage", label: "Usage" },
    { id: "billing", label: "Billing" },
    { id: "activity", label: "Activity" },
];

/** Tab → live section. Every section mounts against the same `organizationId`. */
const SECTIONS: Record<Tab, (props: SectionProps) => ReactElement> = {
    activity: ActivitySection,
    alerts: AlertsSection,
    billing: BillingSection,
    builds: BuildsSection,
    dashboards: DashboardsSection,
    domains: DomainsSection,
    incidents: IncidentsSection,
    invitations: InvitationsSection,
    issues: IssuesSection,
    keys: DeployKeysSection,
    logs: LogsSection,
    members: MembersSection,
    metrics: MetricsSection,
    projects: ProjectsSection,
    secrets: SecretsSection,
    traces: TracesSection,
    uptime: UptimeSection,
    usage: UsageSection,
};

interface OrgFlags {
    deletionRequestedAt?: number;
    suspendedAt?: number;
    suspendedReason?: string;
}

/** Suspension / pending-deletion banners (GAPS.md C1/C2/D3). */
const OrgBanners = ({ org }: { org: OrgFlags }): ReactElement | null => {
    if (org.suspendedAt === undefined && org.deletionRequestedAt === undefined) {
        return null;
    }

    return (
        <>
            {org.suspendedAt === undefined ? null : (
                <div className="callout error" role="alert">
                    This organization is suspended
                    {org.suspendedReason === "dunning"
                        ? " — payment failed. Update your billing details to restore service."
                        : " — spend cap reached. Raise the cap or upgrade your plan to restore service."}
                </div>
            )}
            {org.deletionRequestedAt === undefined ? null : (
                <div className="callout" role="alert">
                    Deletion requested — this organization and all its data will be erased after the 30-day retention window.
                </div>
            )}
        </>
    );
};

/**
 * Per-organization control panel. The active org is resolved from the live
 * `organizations.list` query (so the header stays correct after a rename), and
 * each tab mounts the matching live section against the same `organizationId`.
 */
export const OrganizationDashboard = ({ onBack, organizationId }: OrganizationDashboardProps): ReactElement => {
    const organizations = useQuery(api.organizations.list, {});
    const [tab, setTab] = useState<Tab>("projects");
    // Cross-tab deep-link. `seq` bumps on EVERY navigation so the target section
    // remounts each time (via its `key`) — a one-shot: it consumes `traceId` in
    // its state initializer, never a `useEffect` sync. A manual tab click bumps
    // `seq` with no `traceId`, so a stale trace can't re-open, and deep-linking the
    // SAME trace twice still re-focuses (the seq — hence the key — changed).
    const [focus, setFocus] = useState<{ seq: number; traceId?: string }>({ seq: 0 });
    const navigate = (target: Tab): void => {
        setFocus((previous) => ({ seq: previous.seq + 1 }));
        setTab(target);
    };
    const onOpenTab = (target: "logs" | "traces", context?: { traceId?: string }): void => {
        setFocus((previous) => ({ seq: previous.seq + 1, traceId: context?.traceId }));
        setTab(target);
    };
    const palette = useCommandPalette();

    const org = organizations?.find((candidate) => candidate._id === organizationId);
    const ActiveSection = SECTIONS[tab];
    const paletteCommands: PaletteCommand[] = useMemo(
        () => [
            ...TABS.map((entry) => {
                return {
                    group: "Go to",
                    id: `tab:${entry.id}`,
                    label: entry.label,
                    run: () => {
                        setFocus((previous) => ({ seq: previous.seq + 1 }));
                        setTab(entry.id);
                    },
                };
            }),
            { group: "Actions", id: "back", label: "Back to organizations", run: onBack },
        ],
        [onBack],
    );

    return (
        <div className="stack">
            <div className="breadcrumb">
                <button className="link" onClick={onBack} type="button">
                    ← Organizations
                </button>
                <h2>{org ? org.name : "Organization"}</h2>
                {org ? <span className="badge">{org.plan}</span> : null}
            </div>

            {org ? <OrgBanners org={org as OrgFlags} /> : null}

            <CommandPalette commands={paletteCommands} onClose={palette.close} open={palette.open} />

            <nav className="tabs">
                {TABS.map((entry) => (
                    <button className={entry.id === tab ? "tab active" : "tab"} key={entry.id} onClick={() => navigate(entry.id)} type="button">
                        {entry.label}
                    </button>
                ))}
            </nav>

            <TimeRangeProvider>
                <ActiveSection
                    focusTraceId={tab === "logs" || tab === "traces" ? focus.traceId : undefined}
                    key={`${tab}:${String(focus.seq)}`}
                    onOpenTab={onOpenTab}
                    organizationId={organizationId}
                />
            </TimeRangeProvider>
        </div>
    );
};
