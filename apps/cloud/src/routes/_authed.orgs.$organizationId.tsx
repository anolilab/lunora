import { usePreloadedQuery } from "@lunora/react";
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useMemo } from "react";

import { api } from "../../lunora/_generated/api.js";
import { CommandPalette } from "../client/CommandPalette";
import { TABS } from "../client/tabs";
import { TimeRangeProvider } from "../client/TimeRangeProvider";
import type { PaletteCommand } from "../client/use-command-palette";
import { useCommandPalette } from "../client/use-command-palette";
import { preload } from "../ssr/loader";

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

const OrganizationLayout = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { organizations } = Route.useLoaderData();
    const organizationList = usePreloadedQuery(organizations);
    const navigate = useNavigate();
    const palette = useCommandPalette();

    // The active tab is the last path segment — derived from the URL rather than
    // tracked, so a deep link and a click are indistinguishable.
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const activeTab = pathname.split("/").pop() ?? "projects";

    const org = organizationList.find((candidate) => candidate._id === organizationId);

    const paletteCommands: PaletteCommand[] = useMemo(
        () => [
            ...TABS.map((entry) => {
                return {
                    group: "Go to",
                    id: `tab:${entry.id}`,
                    label: entry.label,
                    run: () => {
                        void navigate({ params: { organizationId }, to: entry.to });
                    },
                };
            }),
            {
                group: "Actions",
                id: "back",
                label: "Back to organizations",
                run: () => {
                    void navigate({ to: "/" });
                },
            },
        ],
        [navigate, organizationId],
    );

    return (
        <div className="stack">
            <div className="breadcrumb">
                <Link className="link" to="/">
                    ← Organizations
                </Link>
                <h2>{org ? org.name : "Organization"}</h2>
                {org ? <span className="badge">{org.plan}</span> : null}
            </div>

            {org ? <OrgBanners org={org as OrgFlags} /> : null}

            <CommandPalette commands={paletteCommands} onClose={palette.close} open={palette.open} />

            <nav className="tabs">
                {TABS.map((entry) => (
                    <Link className={entry.id === activeTab ? "tab active" : "tab"} key={entry.id} params={{ organizationId }} to={entry.to}>
                        {entry.label}
                    </Link>
                ))}
            </nav>

            <TimeRangeProvider>
                <Outlet />
            </TimeRangeProvider>
        </div>
    );
};

/**
 * Per-organization shell: breadcrumb, suspension banners, command palette and the
 * tab bar, with the active tab's route rendered through the `Outlet`.
 *
 * The former `OrganizationDashboard` held the active tab in `useState` and
 * remounted the section via a `key` that bumped on every navigation. The router
 * owns both now — the URL is the active tab, and mounting/unmounting a route
 * component is the remount — so the `seq` counter and the `SECTIONS` lookup table
 * are gone.
 */
export const Route = createFileRoute("/_authed/orgs/$organizationId")({
    component: OrganizationLayout,
    loader: async () => {
        return { organizations: await preload(api.organizations.list, {}) };
    },
});
