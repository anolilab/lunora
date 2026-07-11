import { useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import { ActivitySection } from "./ActivitySection";
import { BillingSection } from "./BillingSection";
import { BuildsSection } from "./BuildsSection";
import { DeployKeysSection } from "./DeployKeysSection";
import { DomainsSection } from "./DomainsSection";
import { InvitationsSection } from "./InvitationsSection";
import { LogsSection } from "./LogsSection";
import { MembersSection } from "./MembersSection";
import { ProjectsSection } from "./ProjectsSection";
import { SecretsSection } from "./SecretsSection";
import type { OrgId } from "./types";
import { UsageSection } from "./UsageSection";

interface OrganizationDashboardProps {
    onBack: () => void;
    organizationId: OrgId;
}

type Tab = "activity" | "billing" | "builds" | "domains" | "invitations" | "keys" | "logs" | "members" | "projects" | "secrets" | "usage";

const TABS: { id: Tab; label: string }[] = [
    { id: "projects", label: "Projects" },
    { id: "members", label: "Members" },
    { id: "keys", label: "Deploy keys" },
    { id: "secrets", label: "Secrets" },
    { id: "domains", label: "Domains" },
    { id: "builds", label: "Builds" },
    { id: "logs", label: "Logs" },
    { id: "invitations", label: "Invitations" },
    { id: "usage", label: "Usage" },
    { id: "billing", label: "Billing" },
    { id: "activity", label: "Activity" },
];

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

    const org = organizations?.find((candidate) => candidate._id === organizationId);

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

            <nav className="tabs">
                {TABS.map((entry) => (
                    <button
                        className={entry.id === tab ? "tab active" : "tab"}
                        key={entry.id}
                        onClick={() => {
                            setTab(entry.id);
                        }}
                        type="button"
                    >
                        {entry.label}
                    </button>
                ))}
            </nav>

            {tab === "projects" ? <ProjectsSection organizationId={organizationId} /> : null}
            {tab === "members" ? <MembersSection organizationId={organizationId} /> : null}
            {tab === "keys" ? <DeployKeysSection organizationId={organizationId} /> : null}
            {tab === "invitations" ? <InvitationsSection organizationId={organizationId} /> : null}
            {tab === "secrets" ? <SecretsSection organizationId={organizationId} /> : null}
            {tab === "domains" ? <DomainsSection organizationId={organizationId} /> : null}
            {tab === "builds" ? <BuildsSection organizationId={organizationId} /> : null}
            {tab === "logs" ? <LogsSection organizationId={organizationId} /> : null}
            {tab === "usage" ? <UsageSection organizationId={organizationId} /> : null}
            {tab === "billing" ? <BillingSection organizationId={organizationId} /> : null}
            {tab === "activity" ? <ActivitySection organizationId={organizationId} /> : null}
        </div>
    );
};
