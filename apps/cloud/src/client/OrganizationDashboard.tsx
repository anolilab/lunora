import { useQuery } from "@cirrus/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../../cirrus/_generated/api.js";
import { DeployKeysSection } from "./DeployKeysSection";
import { InvitationsSection } from "./InvitationsSection";
import { MembersSection } from "./MembersSection";
import { ProjectsSection } from "./ProjectsSection";
import type { OrgId } from "./types";
import { UsageSection } from "./UsageSection";

interface OrganizationDashboardProps {
    onBack: () => void;
    organizationId: OrgId;
}

type Tab = "projects" | "members" | "keys" | "invitations" | "usage";

const TABS: { id: Tab; label: string }[] = [
    { id: "projects", label: "Projects" },
    { id: "members", label: "Members" },
    { id: "keys", label: "Deploy keys" },
    { id: "invitations", label: "Invitations" },
    { id: "usage", label: "Usage" },
];

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
            {tab === "usage" ? <UsageSection organizationId={organizationId} /> : null}
        </div>
    );
};
