import type { ReactElement } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import type { ProjectRuntime } from "../project-runtime";
import { runtimeGaps } from "./runtime-copy";
import { StatusBadge } from "./section-ui";

/**
 * What a Cloudflare Worker project does not get, each with the reason, where a
 * Lunora app shows those features — so nothing is offered that would only fail
 * against a Worker that does not serve Lunora's admin API. Renders nothing for
 * a Lunora app.
 */
export const RuntimeGapsCard = ({ runtime }: { runtime: ProjectRuntime }): null | ReactElement => {
    const gaps = runtimeGaps(runtime);

    if (gaps.length === 0) {
        return null;
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>Not available for a Cloudflare Worker</CardTitle>
                <CardDescription>
                    This project deploys a plain Cloudflare Worker. Its builds are still scanned and its crons and queue consumers still run; these features
                    need a Lunora app.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <ul className="m-0 grid list-none gap-3 p-0">
                    {gaps.map((gap) => (
                        <li className="grid gap-1" key={gap.label}>
                            <span className="flex items-center gap-2 text-sm font-medium">
                                {gap.label}
                                <StatusBadge>unavailable</StatusBadge>
                            </span>
                            <span className="text-sm text-muted-foreground">{gap.reason}</span>
                        </li>
                    ))}
                </ul>
            </CardContent>
        </Card>
    );
};
