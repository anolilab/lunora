import type { ReturnOf } from "@lunora/client";
import { useQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { api } from "../../lunora/_generated/api.js";
import type { Id } from "../../lunora/_generated/dataModel.js";
import { StatusBadge } from "./section-ui";
import type { OrgId } from "./types";

type Advisory = ReturnOf<typeof api.builds.advisories>[number];

/** One finding: what, where, and what to do about it. A note reads quieter than a warning. */
const AdvisoryItem = ({ advisory }: { advisory: Advisory }): ReactElement => (
    <li className="flex flex-col gap-1 border-b py-3 last:border-b-0">
        <div className="flex flex-wrap items-center gap-2">
            {advisory.level === "INFO" ? <StatusBadge>note</StatusBadge> : <StatusBadge tone="warning">warning</StatusBadge>}
            <span className="text-sm font-medium">{advisory.title}</span>
            <span className="text-muted-foreground font-mono text-xs">
                {advisory.location === "bundle" ? `bundle line ${String(advisory.line)} · ${advisory.file}` : `${advisory.file}:${String(advisory.line)}`}
            </span>
        </div>
        <p className="text-muted-foreground text-sm">{advisory.detail}</p>
        <p className="text-sm">{advisory.remediation}</p>
    </li>
);

/**
 * The build scan's findings for one build (`builds.advisories`): code in the
 * built Worker that can run without end. Warnings and notes only — the build
 * and its release went ahead regardless. Loaded per build, so the build list
 * carries counts rather than every finding of every build. Renders nothing
 * until there is something to show.
 */
export const BuildAdvisoriesCard = ({ buildId, organizationId }: { buildId: Id<"builds">; organizationId: OrgId }): ReactElement | null => {
    const advisories = useQuery(api.builds.advisories, { buildId, organizationId });

    if (advisories === undefined || advisories.length === 0) {
        return null;
    }

    const warnings = advisories.filter((advisory) => advisory.level !== "INFO").length;

    return (
        <Card>
            <CardHeader>
                <CardTitle>
                    Build scan{" "}
                    <span className="text-muted-foreground font-mono text-sm">
                        {warnings} {warnings === 1 ? "warning" : "warnings"} · {advisories.length - warnings}{" "}
                        {advisories.length - warnings === 1 ? "note" : "notes"}
                    </span>
                </CardTitle>
                <CardDescription>Code in this build that can run without end and bill storage operations on every pass.</CardDescription>
            </CardHeader>
            <CardContent>
                <ul className="m-0 list-none p-0">
                    {advisories.map((advisory) => (
                        <AdvisoryItem advisory={advisory} key={advisory.cacheKey} />
                    ))}
                </ul>
            </CardContent>
        </Card>
    );
};
