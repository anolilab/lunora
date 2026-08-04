import type { WorkflowInstanceAction, WorkflowInstanceDetail, WorkflowInstanceStatus, WorkflowInstanceSummary } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget } from "../../lib/internal";

/** The status values offered as table filters (the common lifecycle states). */
const STATUS_FILTERS: WorkflowInstanceStatus[] = ["queued", "running", "paused", "waiting", "complete", "errored", "terminated"];

/** The lifecycle mutations exposed as per-instance buttons (the REST `PATCH .../status` set). */
const ACTIONS: WorkflowInstanceAction[] = ["pause", "resume", "terminate"];

interface WorkflowInstanceHistoryProps {
    /** Load one instance's full detail (steps). Defaults to `client.getWorkflowInstance`. */
    readonly loadDetail?: (args: { id: string; name: string }) => Promise<WorkflowInstanceDetail>;
    /** Load the instance list. Defaults to `client.listWorkflowInstances`. A custom loader makes the view read-only. */
    readonly loadInstances?: (args: { name: string; status?: WorkflowInstanceStatus }) => Promise<WorkflowInstanceSummary[]>;
    /** Force-hide the lifecycle (pause/resume/terminate) buttons even when a handler is available — an explicit override of the default capability gate. */
    readonly readOnly?: boolean;
    /** Pause/resume/terminate an instance. Defaults to `client.setWorkflowInstanceStatus`. */
    readonly runAction?: (args: { action: WorkflowInstanceAction; id: string; name: string }) => Promise<{ status: WorkflowInstanceStatus }>;
    /** The deployed Cloudflare workflow name to inspect (`workflows[].name`). */
    readonly workflowName: string;
}

/** The error `code` the runtime proxy raises when no Cloudflare account id / API token is configured. */
const NOT_CONFIGURED_CODE = "WORKFLOWS_NOT_CONFIGURED";

const isNotConfigured = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { code?: unknown }).code === NOT_CONFIGURED_CODE;

/** Compactly render a step's `output` / `error` payload, or a dash when neither is present. */
const formatStepPayload = (step: { error?: unknown; output?: unknown }): string => {
    const value = step.error ?? step.output;

    if (value === undefined) {
        return "—";
    }

    try {
        return JSON.stringify(value);
    } catch {
        return "(unserializable)";
    }
};

/**
 * Instance history for one Cloudflare Workflow, over the admin REST proxy
 * (`/_lunora/admin/workflows*`) — the cross-instance list and per-step timeline
 * the `Workflow` binding can't expose (it only reads a single instance's
 * top-level status). Filter by status, open an instance to see its step
 * timeline, and (when client-owned) pause / resume / terminate it.
 *
 * Requires the worker to be built with a `workflowsClient` (a Cloudflare account
 * id + API token); absent it, the list responds with `configured: false` (an
 * older worker reports `WORKFLOWS_NOT_CONFIGURED` instead) and this renders a
 * "set credentials" state while the workflows keep running.
 *
 * Works under `<LunoraProvider>` via the client's workflow methods; pass the
 * loader props to override the transport (a custom `loadInstances` ⇒ read-only).
 */
export const WorkflowInstanceHistory = ({ loadDetail, loadInstances, readOnly, runAction, workflowName }: WorkflowInstanceHistoryProps): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [instances, setInstances] = useState<null | WorkflowInstanceSummary[]>(null);
    const [detail, setDetail] = useState<null | WorkflowInstanceDetail>(null);
    const [statusFilter, setStatusFilter] = useState<"" | WorkflowInstanceStatus>("");
    const [error, setError] = useState<null | string>(null);
    const [notConfigured, setNotConfigured] = useState(false);
    const [busyId, setBusyId] = useState<null | string>(null);

    const detailImpl = loadDetail ?? ((arguments_: { id: string; name: string }) => client.getWorkflowInstance(arguments_));
    // Lifecycle actions are available only when the list is client-sourced (a
    // custom `loadInstances` ⇒ read-only) or an explicit `runAction` is supplied.
    const clientOwned = loadInstances === undefined;
    const clientAction = clientOwned
        ? (arguments_: { action: WorkflowInstanceAction; id: string; name: string }) => client.setWorkflowInstanceStatus(arguments_)
        : undefined;
    const actionImpl = readOnly ? undefined : (runAction ?? clientAction);

    const load = async (): Promise<void> => {
        setError(null);
        setNotConfigured(false);

        const status = statusFilter === "" ? undefined : statusFilter;

        try {
            // The client-owned path reads the page's `configured` flag: a current
            // worker reports "unconfigured" as a 200 sentinel (no failed request in
            // the console), while an older worker still throws the
            // `WORKFLOWS_NOT_CONFIGURED` code — caught below for back-compat. A
            // custom `loadInstances` override only yields summaries, so it can't be
            // unconfigured.
            if (loadInstances === undefined) {
                const page = await client.listWorkflowInstances({ name: workflowName, status });

                if (page.configured === false) {
                    setInstances(null);
                    setNotConfigured(true);

                    return;
                }

                setInstances(page.instances);

                return;
            }

            setInstances(await loadInstances({ name: workflowName, status }));
        } catch (error_) {
            setInstances(null);

            if (isNotConfigured(error_)) {
                setNotConfigured(true);
            } else {
                setError(errorMessage(error_));
            }
        }
    };

    useEffect(() => {
        /* eslint-disable react-x/set-state-in-effect, react-you-might-not-need-an-effect/no-chain-state-updates, react-you-might-not-need-an-effect/no-adjust-state-on-prop-change -- the effect drives an async reload; closing any open detail is coupled to that fetch (no render-derivable value, and a key-reset would remount and drop the status filter) */
        // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-chain-state-updates -- async reload; the coupled detail close is justified in the eslint-disable above
        setDetail(null);
        fireAndForget(load());
        /* eslint-enable react-x/set-state-in-effect, react-you-might-not-need-an-effect/no-chain-state-updates, react-you-might-not-need-an-effect/no-adjust-state-on-prop-change */
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the workflow or status filter changes
    }, [workflowName, statusFilter]);

    const openDetail = async (id: string): Promise<void> => {
        setError(null);

        try {
            setDetail(await detailImpl({ id, name: workflowName }));
        } catch (error_) {
            setError(errorMessage(error_));
        }
    };

    const act = async (id: string, action: WorkflowInstanceAction): Promise<void> => {
        if (actionImpl === undefined) {
            return;
        }

        setBusyId(id);
        setError(null);

        try {
            await actionImpl({ action, id, name: workflowName });
            await load();
        } catch (error_) {
            setError(errorMessage(error_));
        }

        setBusyId(null);
    };

    return (
        <div className="flex flex-col gap-3" data-testid="lunora-workflow-instances">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{t("Instance history")}</h3>

                <select
                    aria-label={t("Filter by status")}
                    className="h-8 rounded-md border border-input bg-transparent px-2.5 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
                    data-testid="workflow-instances-filter"
                    onChange={(event) => {
                        setStatusFilter(event.target.value as "" | WorkflowInstanceStatus);
                    }}
                    value={statusFilter}
                >
                    <option value="">{t("All statuses")}</option>
                    {STATUS_FILTERS.map((status) => (
                        <option key={status} value={status}>
                            {status}
                        </option>
                    ))}
                </select>
            </div>

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="workflow-instances-error" role="alert">
                    {error}
                </p>
            )}

            {notConfigured && (
                <EmptyState
                    description={t("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in your .dev.vars to enable workflow instance history.")}
                    testId="workflow-instances-unconfigured"
                    title={t("Workflow inspection not configured")}
                />
            )}

            {!notConfigured && instances !== null && instances.length === 0 && (
                <EmptyState
                    description={t("No instances match this filter for the selected workflow.")}
                    testId="workflow-instances-empty"
                    title={t("No instances")}
                />
            )}

            {instances !== null && instances.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="workflow-instances-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("Instance id")}</TableHead>
                                    <TableHead>{t("Status")}</TableHead>
                                    <TableHead>{t("Created")}</TableHead>
                                    <TableHead>{t("Ended")}</TableHead>
                                    <TableHead aria-label={t("Actions")} />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {instances.map((instance) => (
                                    <TableRow data-testid={`workflow-instance-${instance.id}`} key={instance.id}>
                                        <TableCell className="font-mono text-xs">{instance.id}</TableCell>
                                        <TableCell className="font-mono text-xs">{instance.status}</TableCell>
                                        <TableCell className="text-muted-foreground tabular-nums">{instance.createdOn ?? "—"}</TableCell>
                                        <TableCell className="text-muted-foreground tabular-nums">{instance.endedOn ?? "—"}</TableCell>
                                        <TableCell className="text-right">
                                            <div className="flex justify-end gap-1.5">
                                                <Button
                                                    data-testid={`workflow-instance-steps-${instance.id}`}
                                                    onClick={() => {
                                                        fireAndForget(openDetail(instance.id));
                                                    }}
                                                    size="sm"
                                                    type="button"
                                                    variant="outline"
                                                >
                                                    {t("Steps")}
                                                </Button>
                                                {actionImpl !== undefined &&
                                                    ACTIONS.map((action) => (
                                                        <Button
                                                            data-testid={`workflow-instance-${action}-${instance.id}`}
                                                            disabled={busyId === instance.id}
                                                            key={action}
                                                            onClick={() => {
                                                                fireAndForget(act(instance.id, action));
                                                            }}
                                                            size="sm"
                                                            type="button"
                                                            variant="ghost"
                                                        >
                                                            {t(action)}
                                                        </Button>
                                                    ))}
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}

            {detail !== null && (
                <Card className="overflow-hidden py-0" data-testid="workflow-instance-detail">
                    <CardContent className="flex flex-col gap-2 px-4 py-3">
                        <div className="flex items-center justify-between">
                            <span className="font-mono text-xs">
                                {t("Steps")} · {detail.id}
                            </span>
                            <Button
                                data-testid="workflow-instance-detail-close"
                                onClick={() => {
                                    setDetail(null);
                                }}
                                size="xs"
                                type="button"
                                variant="ghost"
                            >
                                {t("Close")}
                            </Button>
                        </div>

                        {detail.steps.length === 0 ? (
                            <p className="text-xs text-muted-foreground">{t("This instance has no recorded steps yet.")}</p>
                        ) : (
                            <Table data-testid="workflow-instance-steps">
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t("Step")}</TableHead>
                                        <TableHead>{t("Type")}</TableHead>
                                        <TableHead>{t("Attempts")}</TableHead>
                                        <TableHead>{t("Started")}</TableHead>
                                        <TableHead>{t("Output")}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {detail.steps.map((step, index) => (
                                        <TableRow data-testid={`workflow-step-${String(index)}`} key={`${step.name}:${String(index)}`}>
                                            <TableCell className="font-mono text-xs">{step.name}</TableCell>
                                            <TableCell className="text-xs text-muted-foreground">{step.type ?? "—"}</TableCell>
                                            <TableCell className="tabular-nums">{step.attempts ?? "—"}</TableCell>
                                            <TableCell className="text-muted-foreground tabular-nums">{step.start ?? "—"}</TableCell>
                                            <TableCell className="font-mono text-xs text-muted-foreground">{formatStepPayload(step)}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </CardContent>
                </Card>
            )}
        </div>
    );
};

export type { WorkflowInstanceHistoryProps };
