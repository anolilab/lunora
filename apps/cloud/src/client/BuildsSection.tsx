import type { ReturnOf } from "@lunora/client";
import { usePreloadedQuery, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { api } from "../../lunora/_generated/api.js";
import type { Id } from "../../lunora/_generated/dataModel.js";
import { AsyncList } from "./AsyncList";
import { Field, Row, RowActions, RowList, StatusBadge } from "./section-ui";
import type { SectionProps } from "./tabs";
import type { ProjectId } from "./types";

type BuildId = Id<"builds">;

/** Build lifecycle → the tone its status chip carries. Unknown states stay neutral. */
const BUILD_TONE = {
    building: "info",
    failed: "danger",
    pending: "warning",
    successful: "success",
} as const;

/**
 * Builds tab (GAPS.md A3). Pick a project → its builds (live, newest first;
 * push-to-deploy creates them) → expand one to tail its streamed output. The
 * log query is live, so lines appear as the runner writes them.
 *
 * Hierarchy: the commit sha is the row's identity, so it leads in mono at full
 * contrast; branch and timestamp are tertiary; the status chip is the only tinted
 * element and it tints the value. The log console keeps a mono block on a surface
 * step — a console should look like a console (mechanical honesty), and error
 * lines colour the LINE, not its background.
 */
export const BuildsSection = ({ organizationId, preloaded }: SectionProps<ReturnOf<typeof api.projects.listByOrg>>): ReactElement => {
    const projects = usePreloadedQuery(preloaded);
    // Plain `string`, not `ProjectId | ""`: Base UI's Select is generic over its value
    // and a branded union makes that inference collapse to the empty-string literal.
    // The brand is reapplied at the query boundary, which is where it means something.
    const [projectId, setProjectId] = useState("");
    const builds = useQuery(api.builds.listByProject, projectId ? { organizationId, projectId: projectId as ProjectId } : "skip");
    const [openBuildId, setOpenBuildId] = useState<BuildId | "">("");
    const logs = useQuery(api.builds.logs, openBuildId ? { buildId: openBuildId, organizationId } : "skip");

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader>
                    <CardTitle>Builds</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-6">
                    <Field htmlFor="build-project" label="Project">
                        <Select
                            onValueChange={(value) => {
                                setProjectId(value ?? "");
                                setOpenBuildId("");
                            }}
                            value={projectId}
                        >
                            <SelectTrigger className="w-full sm:w-80" id="build-project">
                                <SelectValue placeholder="Select a project…" />
                            </SelectTrigger>
                            <SelectContent>
                                {(projects ?? []).map((project) => (
                                    <SelectItem key={project._id} value={project._id}>
                                        {project.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>

                    {projectId ? (
                        <AsyncList
                            empty="No builds yet — push to the connected repository to trigger one."
                            render={(rows) => (
                                <RowList>
                                    {rows.map((build) => (
                                        <Row key={build._id}>
                                            <span className="shrink-0 font-mono text-sm">{build.commitSha.slice(0, 10)}</span>
                                            <span className="text-muted-foreground truncate font-mono text-xs">{build.branch}</span>
                                            <StatusBadge tone={BUILD_TONE[build.status]}>{build.status}</StatusBadge>
                                            <span className="text-muted-foreground hidden font-mono text-xs whitespace-nowrap sm:inline">
                                                {new Date(build.createdAt).toLocaleString()}
                                            </span>
                                            <RowActions>
                                                <Button
                                                    onClick={() => {
                                                        setOpenBuildId(openBuildId === build._id ? "" : build._id);
                                                    }}
                                                    size="sm"
                                                    variant="ghost"
                                                >
                                                    {openBuildId === build._id ? "Hide logs" : "Logs"}
                                                </Button>
                                            </RowActions>
                                        </Row>
                                    ))}
                                </RowList>
                            )}
                            rows={builds}
                        />
                    ) : null}
                </CardContent>
            </Card>

            {openBuildId ? (
                <Card>
                    <CardHeader>
                        <CardTitle>Build output</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <pre className="bg-muted/40 max-h-96 overflow-auto p-4 font-mono text-xs leading-relaxed">
                            {(logs ?? []).map((entry) => (
                                <span className={entry.level === "error" ? "text-destructive block" : "block"} key={`${String(entry.createdAt)}-${entry.line}`}>
                                    {entry.line}
                                </span>
                            ))}
                            {logs?.length === 0 ? <span className="text-muted-foreground">No output yet…</span> : null}
                        </pre>
                    </CardContent>
                </Card>
            ) : null}
        </div>
    );
};
