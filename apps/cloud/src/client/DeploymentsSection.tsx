import {
    ArrowDown01Icon,
    ArrowLeft01Icon,
    ArrowUpRight01Icon,
    GitBranchIcon,
    GitCommitIcon,
    GithubIcon,
    GitlabIcon,
    Globe02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReturnOf } from "@lunora/client";
import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { api } from "../../lunora/_generated/api.js";
import { ProjectGraph } from "./ProjectGraph";
import { StatusBadge } from "./section-ui";
import type { OrgId, ProjectId } from "./types";

interface DeploymentsSectionProps {
    githubRepo?: string;
    gitProvider?: string;
    onBack: () => void;
    organizationId: OrgId;
    projectId: ProjectId; // secret-scanner:allow -- domain field name
    projectName: string;
}

type Deployment = ReturnOf<typeof api.deployments.listByProject>[number];
type StatusTone = "danger" | "neutral" | "success" | "warning";

/** Stable empty array for list props (a fresh `[]` per render trips react-perf). */
const EMPTY: never[] = [];

/** A build-log line is a "warning" when an info line mentions one (no warn level). */
const WARN_RE = /\bwarn/i;
/** Strip the scheme so a URL reads as a bare host in the UI. */
const PROTOCOL_RE = /^https?:\/\//;

const STATUS_META: Record<string, { dot: string; label: string; tone: StatusTone }> = {
    building: { dot: "bg-warning", label: "Building", tone: "warning" },
    failed: { dot: "bg-destructive", label: "Failed", tone: "danger" },
    live: { dot: "bg-success", label: "Live", tone: "success" },
    provisioning: { dot: "bg-warning", label: "Provisioning", tone: "warning" },
    queued: { dot: "bg-warning", label: "Queued", tone: "warning" },
    superseded: { dot: "bg-muted-foreground", label: "Superseded", tone: "neutral" },
    verifying: { dot: "bg-warning", label: "Verifying", tone: "warning" },
};

const statusMeta = (status: string): { dot: string; label: string; tone: StatusTone } =>
    STATUS_META[status] ?? { dot: "bg-muted-foreground", label: status, tone: "neutral" };

const relativeTime = (ms: number): string => {
    const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));

    if (seconds < 60) {
        return `${String(seconds)}s ago`;
    }

    const minutes = Math.floor(seconds / 60);

    if (minutes < 60) {
        return `${String(minutes)}m ago`;
    }

    const hours = Math.floor(minutes / 60);

    if (hours < 24) {
        return `${String(hours)}h ago`;
    }

    return `${String(Math.floor(hours / 24))}d ago`;
};

const formatDuration = (ms: number): string => {
    const seconds = Math.max(0, Math.round(ms / 1000));

    if (seconds < 60) {
        return `${String(seconds)}s`;
    }

    return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
};

const formatTime = (ms: number): string => new Date(ms).toLocaleString();

/** The mono-uppercase back affordance shared by the hero and the empty state. */
const BackLink = ({ onBack }: { onBack: () => void }): ReactElement => (
    <button
        className="flex w-fit cursor-pointer items-center gap-1.5 font-mono text-[11px] tracking-[0.07em] text-muted-foreground uppercase transition-colors hover:text-foreground"
        onClick={onBack}
        type="button"
    >
        <HugeiconsIcon className="size-3.5" icon={ArrowLeft01Icon} strokeWidth={2} />
        Projects
    </button>
);

/**
 * The page hero: the project name (primary), the active deployment's live status,
 * and a Visit action — over a mono metadata strip (who deployed / when / how long
 * to ready). Replaces the boxed overview stats so the name is the one thing seen
 * first (three-layer hierarchy) and floats on the background, split from the
 * content by a single hairline.
 */
const ProjectHero = ({
    deployment,
    onBack,
    projectName,
    visitUrl,
}: {
    deployment: Deployment;
    onBack: () => void;
    projectName: string;
    visitUrl?: string;
}): ReactElement => {
    const meta = statusMeta(deployment.status);
    const settled = deployment.status === "live" || deployment.status === "superseded";
    const readyMs = settled ? deployment.updatedAt - deployment.createdAt : Date.now() - deployment.createdAt;

    return (
        <div className="flex flex-col gap-5 border-b border-border pb-6">
            <BackLink onBack={onBack} />

            <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
                <h2 className="m-0 text-2xl font-medium tracking-[-0.02em]">{projectName}</h2>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs font-medium">
                    <span className={cn("size-1.5 shrink-0 rounded-full", meta.dot)} />
                    {meta.label}
                </span>
                {visitUrl ? (
                    <a
                        className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background no-underline transition-colors hover:bg-foreground/90"
                        href={visitUrl}
                        rel="noreferrer"
                        target="_blank"
                    >
                        Visit
                        <HugeiconsIcon className="size-3.5" icon={ArrowUpRight01Icon} strokeWidth={2} />
                    </a>
                ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-x-10 gap-y-2 text-sm">
                <span className="flex items-center gap-2">
                    <span className="font-mono text-[10px] tracking-[0.09em] text-muted-foreground uppercase">Created</span>
                    <span className="grid size-5 shrink-0 place-items-center rounded bg-foreground text-[9px] font-semibold text-background">
                        {deployment.createdBy.charAt(0).toUpperCase()}
                    </span>
                    <span className="truncate">{deployment.createdBy}</span>
                    <span className="text-muted-foreground">{relativeTime(deployment.createdAt)}</span>
                </span>
                <span className="flex items-center gap-2">
                    <span className="font-mono text-[10px] tracking-[0.09em] text-muted-foreground uppercase">Ready in</span>
                    <span className="tabular-nums">{formatDuration(readyMs)}</span>
                </span>
            </div>
        </div>
    );
};

/** Custom domains + the latest deployment's URL. */
const DomainsCard = ({ domains, url }: { domains: ReturnOf<typeof api.domains.list>; url?: string }): ReactElement => (
    <Card>
        <CardHeader>
            <CardTitle>Domains</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5">
            {domains.map((domain) => (
                <div className="flex items-center gap-2.5 text-sm" key={domain._id}>
                    <HugeiconsIcon className="size-4 shrink-0 text-muted-foreground" icon={Globe02Icon} strokeWidth={2} />
                    <a href={`https://${domain.hostname}`} rel="noreferrer" target="_blank">
                        {domain.hostname}
                    </a>
                    <StatusBadge tone={domain.verifiedAt ? "success" : "warning"}>{domain.verifiedAt ? "verified" : "pending"}</StatusBadge>
                </div>
            ))}
            {url ? (
                <div className="flex items-center gap-2.5 text-sm">
                    <HugeiconsIcon className="size-4 shrink-0 text-muted-foreground" icon={GitCommitIcon} strokeWidth={2} />
                    <a href={url} rel="noreferrer" target="_blank">
                        {url.replace(PROTOCOL_RE, "")}
                    </a>
                </div>
            ) : null}
            {domains.length === 0 && url === undefined ? <span className="text-sm text-muted-foreground">No domains yet.</span> : null}
        </CardContent>
    </Card>
);

/** The git source: repo, branch, and latest commit. Renders nothing with no data. */
const SourceCard = ({
    branch,
    commitSha,
    gitProvider,
    githubRepo,
}: {
    branch?: string;
    commitSha?: string;
    githubRepo?: string;
    gitProvider?: string;
}): null | ReactElement => {
    if (githubRepo === undefined && branch === undefined && commitSha === undefined) {
        return null;
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>Source</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5 text-sm">
                {githubRepo ? (
                    <div className="flex items-center gap-2.5">
                        <HugeiconsIcon
                            className="size-4 shrink-0 text-muted-foreground"
                            icon={gitProvider === "gitlab" ? GitlabIcon : GithubIcon}
                            strokeWidth={2}
                        />
                        {githubRepo}
                    </div>
                ) : null}
                {branch ? (
                    <div className="flex items-center gap-2.5">
                        <HugeiconsIcon className="size-4 shrink-0 text-muted-foreground" icon={GitBranchIcon} strokeWidth={2} />
                        {branch}
                    </div>
                ) : null}
                {commitSha ? (
                    <div className="flex items-center gap-2.5">
                        <HugeiconsIcon className="size-4 shrink-0 text-muted-foreground" icon={GitCommitIcon} strokeWidth={2} />
                        <span className="font-mono text-xs">{commitSha.slice(0, 7)}</span>
                    </div>
                ) : null}
            </CardContent>
        </Card>
    );
};

type BuildId = ReturnOf<typeof api.builds.listByProject>[number]["_id"];
type LogEntry = ReturnOf<typeof api.builds.logs>[number];

const logLineClass = (entry: LogEntry): string => {
    if (entry.level === "error") {
        return "log-line error";
    }

    if (WARN_RE.test(entry.line)) {
        return "log-line warn";
    }

    return "log-line";
};

/** The latest build's streamed logs, with All / Errors / Warnings tabs (collapsible). */
const BuildLogsCard = ({ buildId, organizationId }: { buildId: BuildId; organizationId: OrgId }): ReactElement => {
    const logs = useQuery(api.builds.logs, { buildId, organizationId });
    const [open, setOpen] = useState(true);
    const [tab, setTab] = useState<"all" | "errors" | "warnings">("all");

    const all = logs ?? [];
    const errors = all.filter((entry) => entry.level === "error");
    const warnings = all.filter((entry) => entry.level === "info" && WARN_RE.test(entry.line));

    let shown = all;

    if (tab === "errors") {
        shown = errors;
    } else if (tab === "warnings") {
        shown = warnings;
    }

    const tabs: ReadonlyArray<{ count: number; id: "all" | "errors" | "warnings"; label: string }> = [
        { count: all.length, id: "all", label: "All Logs" },
        { count: errors.length, id: "errors", label: "Errors" },
        { count: warnings.length, id: "warnings", label: "Warnings" },
    ];

    return (
        <Card>
            <CardHeader>
                <button
                    className="flex w-full cursor-pointer items-center gap-2"
                    onClick={() => {
                        setOpen((value) => !value);
                    }}
                    type="button"
                >
                    <HugeiconsIcon
                        className={cn("size-4 text-muted-foreground transition-transform", open ? "" : "-rotate-90")}
                        icon={ArrowDown01Icon}
                        strokeWidth={2}
                    />
                    <CardTitle>Build Logs</CardTitle>
                </button>
            </CardHeader>
            {open ? (
                <CardContent className="flex flex-col gap-3">
                    <div className="flex flex-wrap gap-1.5">
                        {tabs.map((entry) => (
                            <button
                                className={cn(
                                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
                                    tab === entry.id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent",
                                )}
                                key={entry.id}
                                onClick={() => {
                                    setTab(entry.id);
                                }}
                                type="button"
                            >
                                {entry.label}
                                <span className="font-mono">{entry.count}</span>
                            </button>
                        ))}
                    </div>
                    <pre className="bg-muted/40 max-h-96 overflow-auto p-4 font-mono text-xs leading-relaxed">
                        {shown.map((entry) => (
                            <span className={logLineClass(entry)} key={`${String(entry.createdAt)}-${entry.line}`}>
                                [{new Date(entry.createdAt).toLocaleTimeString()}] {entry.line}
                                {"\n"}
                            </span>
                        ))}
                        {shown.length === 0 ? "No log lines yet." : null}
                    </pre>
                </CardContent>
            ) : null}
        </Card>
    );
};

/** The full deployment history — click a row to inspect it; roll back superseded. */
const DeploymentsTable = ({
    activeId,
    deployments,
    onRollback,
    onSelect,
}: {
    activeId?: Deployment["_id"];
    deployments: Deployment[];
    onRollback: (id: Deployment["_id"]) => void;
    onSelect: (id: Deployment["_id"]) => void;
}): ReactElement => (
    <Card>
        <CardHeader>
            <CardTitle>Deployments</CardTitle>
            <CardDescription>Select a deployment to inspect it above.</CardDescription>
        </CardHeader>
        <CardContent>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Kind</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>URL</TableHead>
                        <TableHead>Branch</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead className="sr-only">Actions</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {deployments.map((deployment) => (
                        <TableRow
                            className={cn("cursor-pointer", deployment._id === activeId && "bg-accent hover:bg-accent")}
                            key={deployment._id}
                            onClick={() => {
                                onSelect(deployment._id);
                            }}
                        >
                            <TableCell>
                                <StatusBadge>{deployment.kind}</StatusBadge>
                            </TableCell>
                            <TableCell>
                                <StatusBadge tone={statusMeta(deployment.status).tone}>{deployment.status}</StatusBadge>
                            </TableCell>
                            <TableCell>
                                {deployment.url ? (
                                    <a
                                        href={deployment.url}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                        }}
                                        rel="noreferrer"
                                        target="_blank"
                                    >
                                        {deployment.url.replace(PROTOCOL_RE, "")}
                                    </a>
                                ) : (
                                    <span className="text-muted-foreground">—</span>
                                )}
                            </TableCell>
                            <TableCell>{deployment.branch ?? <span className="text-muted-foreground">—</span>}</TableCell>
                            <TableCell className="text-muted-foreground">{formatTime(deployment.createdAt)}</TableCell>
                            <TableCell>
                                {deployment.status === "superseded" ? (
                                    <Button
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            onRollback(deployment._id);
                                        }}
                                        size="sm"
                                        variant="ghost"
                                    >
                                        Roll back
                                    </Button>
                                ) : null}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </CardContent>
    </Card>
);

/**
 * The project detail view: an overview of the latest deployment (who / status /
 * time-to-ready), its domains, its git source, and the latest build's streamed
 * logs — plus the full deployment history (with rollback) below. Deploys are
 * created out-of-band (the CLI or the GitHub push webhook), so this is read-only
 * apart from rollback.
 */
export const DeploymentsSection = ({ gitProvider, githubRepo, onBack, organizationId, projectId, projectName }: DeploymentsSectionProps): ReactElement => {
    const deployments = useQuery(api.deployments.listByProject, { organizationId, projectId });
    const builds = useQuery(api.builds.listByProject, { organizationId, projectId });
    const domains = useQuery(api.domains.list, { organizationId, projectId });
    const rollback = useMutation(api.deployments.rollback);

    // The deployment whose detail is shown — a clicked one, else the newest.
    const [activeId, setActiveId] = useState<Deployment["_id"] | null>(null);

    const active = (activeId === null ? undefined : deployments?.find((deployment) => deployment._id === activeId)) ?? deployments?.[0];
    const isLatest = active !== undefined && active._id === deployments?.[0]?._id;
    // The design session's `builds` table carried a `deploymentId` linking a build to
    // the deployment it produced; this branch's schema has no such column, so a build
    // can only be matched to the NEWEST deployment. Viewing an older deployment shows
    // no build rather than a wrong one.
    const activeBuild = isLatest ? builds?.[0] : undefined;
    const branch = active?.branch ?? activeBuild?.branch;

    const header = (
        <div className="flex items-center gap-3">
            <Button onClick={onBack} size="sm" variant="ghost">
                ← Projects
            </Button>
            <h3>{projectName}</h3>
        </div>
    );

    if (deployments?.length === 0) {
        return (
            <div className="flex flex-col gap-6">
                {header}
                <Card>
                    <CardContent className="py-10 text-center text-sm text-muted-foreground">
                        No deployments yet — push to {githubRepo ? <span className="font-medium text-foreground">{githubRepo}</span> : "the connected repo"} or
                        run <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">lunora deploy</code>.
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-6">
            {active ? <ProjectHero deployment={active} onBack={onBack} projectName={projectName} visitUrl={active.url} /> : header}
            {/* Two columns, as the design has it — Domains and Source are peers. */}
            <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2">
                <DomainsCard domains={domains ?? EMPTY} url={active?.url} />
                <SourceCard branch={branch} commitSha={activeBuild?.commitSha} githubRepo={githubRepo} gitProvider={gitProvider} />
            </div>
            {active?.bindings && active.bindings.length > 0 ? (
                <Card>
                    <CardHeader>
                        <CardTitle>Bindings</CardTitle>
                        <CardDescription>Cloudflare resources this deployment connects to, from its wrangler config.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <ProjectGraph bindings={active.bindings} projectName={projectName} />
                    </CardContent>
                </Card>
            ) : null}
            {activeBuild ? <BuildLogsCard buildId={activeBuild._id} organizationId={organizationId} /> : null}
            <DeploymentsTable
                activeId={active?._id}
                deployments={deployments ?? EMPTY}
                onRollback={(id) => {
                    void rollback.mutate({ id, organizationId });
                }}
                onSelect={setActiveId}
            />
        </div>
    );
};
