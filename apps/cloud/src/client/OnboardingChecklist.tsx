import { useQuery } from "@lunora/react";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import { api } from "../../lunora/_generated/api.js";
import { COLUMN_LABEL } from "./section-styles";
import type { OrgId } from "./types";

/**
 * First-run checklist on the Projects tab (GAPS.md ring 3 #5).
 *
 * Renders only until the org finishes, then disappears for good — a permanent
 * "you're all set" panel is clutter charged to every future visit for a message
 * that was only useful once.
 *
 * The state is derived server-side from real rows (`onboarding.checklist`), so
 * this needs no local storage, no dismissal flag, and stays correct if an org
 * deletes the thing a step was counting.
 */

/** Copy for each step, keyed by the query's stable ids. */
const STEP_COPY: Record<string, { hint: string; label: string; to?: "/orgs/$organizationId/keys" }> = {
    deploy: { hint: "Push your first build with `lunora cloud deploy`.", label: "Deploy" },
    key: { hint: "Mint a deploy key so CI can ship.", label: "Issue a deploy key", to: "/orgs/$organizationId/keys" },
    live: { hint: "Your deployment is serving traffic.", label: "See it live" },
    project: { hint: "Create a project below to deploy into.", label: "Create a project" },
};

export const OnboardingChecklist = ({ organizationId }: { organizationId: OrgId }): ReactElement | null => {
    const checklist = useQuery(api.onboarding.checklist, { organizationId });

    // Nothing while loading, and nothing once finished. A checklist that flashes in
    // and out on every navigation is worse than one that appears a beat late.
    if (checklist === undefined || checklist.complete) {
        return null;
    }

    const doneCount = checklist.steps.filter((step) => step.done).length;
    // The first unfinished step is the one to do next — the list is ordered by
    // dependency, so nothing later is actionable before it.
    const nextIndex = checklist.steps.findIndex((step) => !step.done);

    return (
        <Card>
            <CardHeader>
                <CardTitle>Get your first deployment live</CardTitle>
                <CardDescription>
                    {doneCount} of {checklist.steps.length} done — this panel disappears once you finish.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <ol className="m-0 grid list-none gap-3 p-0">
                    {checklist.steps.map((step, index) => {
                        const copy = STEP_COPY[step.id];
                        const isNext = index === nextIndex;

                        return (
                            <li className="flex items-start gap-3" key={step.id}>
                                <span
                                    aria-hidden="true"
                                    className={cn(
                                        "mt-0.5 flex size-5 shrink-0 items-center justify-center border font-mono text-[10px] tabular-nums",
                                        step.done ? "border-transparent bg-emerald-600 text-white dark:bg-emerald-500" : "border-border text-muted-foreground",
                                    )}
                                >
                                    {step.done ? "✓" : index + 1}
                                </span>
                                <div className="flex min-w-0 flex-col gap-0.5">
                                    <span className={cn("text-sm", step.done ? "text-muted-foreground line-through" : "font-medium")}>
                                        {copy?.label ?? step.id}
                                        <span className="sr-only">{step.done ? " — done" : ""}</span>
                                    </span>
                                    {isNext ? (
                                        <span className="text-muted-foreground text-xs">
                                            {copy?.hint}{" "}
                                            {copy?.to === undefined ? null : (
                                                <Link className="cross-tab-link" params={{ organizationId }} to={copy.to}>
                                                    Go there
                                                </Link>
                                            )}
                                        </span>
                                    ) : null}
                                </div>
                                {isNext ? <span className={cn(COLUMN_LABEL, "text-muted-foreground ml-auto shrink-0")}>next</span> : null}
                            </li>
                        );
                    })}
                </ol>
            </CardContent>
        </Card>
    );
};
