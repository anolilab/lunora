import { UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";

import { OrganizationsSheet } from "./OrganizationsSheet";
import type { OrgId } from "./types";

interface OrgSummary {
    _id: OrgId;
    name: string;
    plan: string;
}

/** First letter of a name, for the square monogram logo mark. */
const initialOf = (name: string | undefined): string => name?.trim().charAt(0).toUpperCase() ?? "•";

/**
 * Sidebar-header org switcher — a monogram + the current org's name + an
 * up/down affordance, as a native disclosure (details/summary) that drops down
 * the full org list. Native so it works before hydration and needs no open/close
 * state; picking an org navigates to its Projects tab (the dashboard default),
 * and the disclosure collapses on navigation.
 */
export const OrgSwitcher = ({ orgId, organizations }: { organizations: ReadonlyArray<OrgSummary>; orgId: OrgId }): ReactElement => {
    const current = organizations.find((organization) => organization._id === orgId);
    const detailsRef = useRef<HTMLDetailsElement>(null);
    const [sheetOpen, setSheetOpen] = useState(false);

    return (
        <>
            <details className="group relative" ref={detailsRef}>
                <summary className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-sidebar-border bg-sidebar-accent/60 p-1.5 pe-2.5 select-none hover:bg-sidebar-accent group-data-[collapsible=icon]:size-10 group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0 [&::-webkit-details-marker]:hidden">
                    {/* The logo tile; in the icon rail it is all that shows. */}
                    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-(image:--brand-gradient) text-[12px] font-semibold text-white shadow-(--brand-shadow) group-data-[collapsible=icon]:size-10 group-data-[collapsible=icon]:rounded-xl group-data-[collapsible=icon]:text-[14px]">
                        {initialOf(current?.name)}
                    </span>
                    {/* `sr-only`, not `hidden`, in the rail: the name stays the summary's accessible name. */}
                    <span className="flex-1 truncate text-sm font-medium group-data-[collapsible=icon]:sr-only">{current ? current.name : "Organization"}</span>
                    {current ? (
                        <Badge className="shrink-0 font-mono text-[10px] tracking-[0.06em] uppercase group-data-[collapsible=icon]:hidden" variant="secondary">
                            {current.plan}
                        </Badge>
                    ) : null}
                    <HugeiconsIcon
                        className="size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden"
                        icon={UnfoldMoreIcon}
                        strokeWidth={2}
                    />
                </summary>
                {/* Under the switcher when expanded; out to the right of the rail when collapsed. */}
                <div className="absolute inset-x-0 top-[calc(100%+6px)] z-20 grid gap-0.5 rounded-xl border border-border bg-popover p-1 shadow-lg group-data-[collapsible=icon]:top-0 group-data-[collapsible=icon]:right-auto group-data-[collapsible=icon]:left-[calc(100%+10px)] group-data-[collapsible=icon]:w-64">
                    <p className="m-0 px-2 pt-2 pb-1 font-mono text-[11px] tracking-[0.07em] text-muted-foreground uppercase">Organizations</p>
                    {organizations.map((organization) => (
                        <Link
                            activeProps={{ className: "bg-accent" }}
                            className="flex items-center gap-2.5 rounded-lg px-2 py-[7px] text-[13px] text-foreground no-underline hover:bg-accent"
                            key={organization._id}
                            params={{ organizationId: organization._id }}
                            to="/orgs/$organizationId/projects"
                        >
                            <span className="grid size-5 shrink-0 place-items-center rounded bg-foreground text-[10px] font-semibold text-background">
                                {initialOf(organization.name)}
                            </span>
                            <span className="flex-1 truncate">{organization.name}</span>
                            <span className="inline-flex items-center rounded-full border border-border bg-secondary px-[7px] py-0.5 font-mono text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
                                {organization.plan}
                            </span>
                        </Link>
                    ))}
                    <button
                        className="mt-0.5 cursor-pointer rounded-lg border-t border-border p-2 text-left font-mono text-[11px] tracking-[0.04em] text-muted-foreground uppercase hover:text-foreground"
                        onClick={() => {
                            // Collapse the native disclosure, then open the panel over the page.
                            detailsRef.current?.removeAttribute("open");
                            setSheetOpen(true);
                        }}
                        type="button"
                    >
                        All organizations →
                    </button>
                </div>
            </details>
            <OrganizationsSheet onOpenChange={setSheetOpen} open={sheetOpen} organizations={organizations} orgId={orgId} />
        </>
    );
};
