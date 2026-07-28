import { HugeiconsIcon } from "@hugeicons/react";
import type { ReturnOf } from "@lunora/client";
import { usePreloadedQuery } from "@lunora/react";
import { createFileRoute, Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useMemo } from "react";

import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

import { api } from "../../lunora/_generated/api.js";
import { DashboardLayout } from "../client/DashboardLayout";
import { OrgSwitcher } from "../client/OrgSwitcher";
import { TAB_GROUPS, TABS } from "../client/tabs";
import { TimeRangeProvider } from "../client/TimeRangeProvider";
import type { OrgId } from "../client/types";
import type { PaletteCommand } from "../client/use-command-palette";
import { preload } from "../ssr/loader";

/** Strip a trailing slash before reading the active segment off the pathname. */
const TRAILING_SLASH = /\/$/;

/**
 * The suspension/deletion fields off an organization row.
 *
 * Derived from the query's own return type rather than hand-declared. The previous
 * local shadow typed these as `number | undefined` and was reconciled with an
 * `org as OrgFlags` cast — which is exactly what hid a live bug: these columns come
 * from D1, which returns explicit `null` for an unset value, so the `=== undefined`
 * tests below were false for every organization and BOTH banners rendered on every
 * one. The cast asserted a shape the data never had, so the compiler could not say
 * so. Typing from the source keeps `null` visible.
 */
type OrgFlags = Pick<ReturnOf<typeof api.organizations.list>[number], "deletionRequestedAt" | "suspendedAt" | "suspendedReason">;

/**
 * Why an organization is suspended, keyed by `suspendedReason`. A lookup rather than
 * a ternary so a third reason is one entry, not a nested conditional.
 */
const SUSPENSION_DETAIL: Record<string, string> = {
    default: " — spend cap reached. Raise the cap or upgrade your plan to restore service.",
    dunning: " — payment failed. Update your billing details to restore service.",
};

/** Suspension / pending-deletion banners (GAPS.md C1/C2/D3). */
const OrgBanners = ({ org }: { org: OrgFlags }): ReactElement | null => {
    // `== null` on purpose: D1 hands back `null`, the validators describe the column
    // as optional, and both mean "not set". `=== undefined` caught only one of them.
    const suspended = org.suspendedAt != null;
    const deleting = org.deletionRequestedAt != null;

    if (!suspended && !deleting) {
        return null;
    }

    return (
        <>
            {suspended ? (
                <div className="callout error" role="alert">
                    This organization is suspended
                    {SUSPENSION_DETAIL[org.suspendedReason ?? ""] ?? SUSPENSION_DETAIL.default}
                </div>
            ) : null}
            {deleting ? (
                <div className="callout" role="alert">
                    Deletion requested — this organization and all its data will be erased after the 30-day retention window.
                </div>
            ) : null}
        </>
    );
};

const OrganizationLayout = (): ReactElement => {
    const { organizationId } = Route.useParams();
    const { session } = Route.useRouteContext();
    const { organizations } = Route.useLoaderData();
    const organizationList = usePreloadedQuery(organizations);
    const navigate = useNavigate();
    const pathname = useLocation({ select: (location) => location.pathname });

    const org = organizationList.find((candidate) => candidate._id === organizationId);
    const activeSegment = pathname.replace(TRAILING_SLASH, "").split("/").pop();
    const activeTab = TABS.find((entry) => entry.id === activeSegment);

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
        <DashboardLayout
            commands={paletteCommands}
            eyebrow={activeTab?.group}
            sidebarHeader={<OrgSwitcher organizations={organizationList} orgId={organizationId as OrgId} />}
            sidebarNav={TAB_GROUPS.map((group) => (
                <SidebarGroup key={group}>
                    <SidebarGroupLabel className="font-mono text-[10px] tracking-[0.09em] text-muted-foreground uppercase">{group}</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {TABS.filter((entry) => entry.group === group).map((entry) => {
                                const isActive = activeSegment === entry.id;

                                return (
                                    <SidebarMenuItem key={entry.id}>
                                        <SidebarMenuButton
                                            // Inactive nav is muted (colour-as-hierarchy); the active tab keeps
                                            // full contrast and gets a single aurora-violet edge accent — the
                                            // one expressive colour moment in the chrome.
                                            className={cn(
                                                !isActive && "text-muted-foreground",
                                                isActive &&
                                                    "relative before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-[var(--aurora-violet)]",
                                            )}
                                            isActive={isActive}
                                            render={<Link params={{ organizationId }} to={entry.to} />}
                                            tooltip={entry.label}
                                        >
                                            <HugeiconsIcon icon={entry.icon} strokeWidth={2} />
                                            <span>{entry.label}</span>
                                        </SidebarMenuButton>
                                    </SidebarMenuItem>
                                );
                            })}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            ))}
            title={activeTab?.label ?? "Dashboard"}
            userEmail={session.user.email}
        >
            {org ? <OrgBanners org={org} /> : null}
            <TimeRangeProvider>
                <Outlet />
            </TimeRangeProvider>
        </DashboardLayout>
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
