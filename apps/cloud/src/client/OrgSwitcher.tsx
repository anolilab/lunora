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
                <summary className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-2 shadow-sm select-none hover:bg-accent [&::-webkit-details-marker]:hidden">
                    <span className="grid size-6 shrink-0 place-items-center rounded-md bg-foreground text-[11px] font-semibold text-background">
                        {initialOf(current?.name)}
                    </span>
                    <span className="flex-1 truncate text-sm font-medium">{current ? current.name : "Organization"}</span>
                    {current ? (
                        <Badge className="shrink-0 font-mono text-[10px] tracking-[0.06em] uppercase" variant="secondary">
                            {current.plan}
                        </Badge>
                    ) : null}
                    <HugeiconsIcon className="size-4 shrink-0 text-muted-foreground" icon={UnfoldMoreIcon} strokeWidth={2} />
                </summary>
                <div className="absolute inset-x-0 top-[calc(100%+6px)] z-20 grid gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-lg">
                    <p className="m-0 px-2 pt-2 pb-1 font-mono text-[11px] tracking-[0.07em] text-muted-foreground uppercase">Organizations</p>
                    {organizations.map((organization) => (
                        <Link
                            activeProps={{ className: "bg-accent" }}
                            className="flex items-center gap-2.5 rounded-md px-2 py-[7px] text-[13px] text-foreground no-underline hover:bg-accent"
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
                        className="mt-0.5 cursor-pointer rounded-md border-t border-border p-2 text-left font-mono text-[11px] tracking-[0.04em] text-muted-foreground uppercase hover:text-foreground"
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
            <OrganizationsSheet onOpenChange={setSheetOpen} open={sheetOpen} orgId={orgId} organizations={organizations} />
        </>
    );
};
