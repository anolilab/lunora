import type { ReactElement } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import type { BuildAdvisory } from "../builds/runner";
import { StatusBadge } from "./section-ui";

/** One finding: what, where, and what to do about it. */
const AdvisoryItem = ({ advisory }: { advisory: BuildAdvisory }): ReactElement => (
    <li className="flex flex-col gap-1 border-b py-3 last:border-b-0">
        <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="warning">warning</StatusBadge>
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
 * built Worker that can run without end. Warnings only — the build and its
 * release went ahead regardless. Renders nothing when there are none.
 */
export const BuildAdvisoriesCard = ({ advisories }: { advisories: ReadonlyArray<BuildAdvisory> | undefined }): ReactElement | null => {
    if (advisories === undefined || advisories.length === 0) {
        return null;
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>
                    Build warnings <span className="text-muted-foreground font-mono text-sm">{advisories.length}</span>
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
