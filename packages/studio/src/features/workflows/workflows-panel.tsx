import { useLunora } from "@lunora/react";
import type { ChangeEvent, MouseEvent, ReactElement } from "react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Textarea } from "../../components/ui/textarea";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { CreateWorkflowInstanceResult, WorkflowInstanceStatusResult, WorkflowMetadata, WorkflowsResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../lib/internal";
import { WorkflowInstanceHistory } from "./workflow-instances";

const CREATE_WORKFLOW_INSTANCE = adminRef(ADMIN_FUNCTIONS.createWorkflowInstance);
const GET_WORKFLOW_INSTANCE_STATUS = adminRef(ADMIN_FUNCTIONS.getWorkflowInstanceStatus);

/** One workflow instance the panel is observing — created here or refreshed by id. */
interface ObservedInstance {
    error?: { message: string; name: string };
    exportName: string;
    id: string;
    output?: unknown;
    status: WorkflowInstanceStatusResult["status"];
}

/** Render a workflow instance's `output`/`error` payload compactly, or a dash when neither is present. */
const formatPayload = (instance: ObservedInstance): string => {
    if (instance.error) {
        return `${instance.error.name}: ${instance.error.message}`;
    }

    if (instance.output === undefined) {
        return "—";
    }

    try {
        return JSON.stringify(instance.output);
    } catch {
        return "(unserializable)";
    }
};

/**
 * The Workflows inspector — lists the deployment's declared Cloudflare Workflows
 * (`defineWorkflow`) and lets you start and observe instances of them.
 *
 * Per workflow it shows the `defineWorkflow` export, the generated
 * `WorkflowEntrypoint` class, the wrangler `Workflow` binding, and the stable
 * deployed `workflows[].name` — statically discovered by `@lunora/codegen` and
 * served by the list-workflows admin RPC, so it refreshes on every codegen run
 * (dev: on save; prod: on deploy).
 *
 * The "Start instance" form calls the create-instance admin RPC
 * (`binding.create({ id?, params })`); each created/refreshed instance is added
 * to the observed-instances table, whose "Refresh" re-reads the instance-status
 * admin RPC (`binding.get(id).status()`).
 */
/** The effective selection: the operator's pick while it still exists, else the first declared workflow. Derived rather than synced in an effect, so a codegen that drops the selected workflow re-defaults on the next render. */
const effectiveExportName = (workflows: ReadonlyArray<WorkflowMetadata>, selectedExport: string): string => {
    if (workflows.some((workflow) => workflow.exportName === selectedExport)) {
        return selectedExport;
    }

    return workflows[0]?.exportName ?? "";
};

const WorkflowsPanel = (): ReactElement => {
    const client = useLunora();
    const t = useT();

    // Deployment-wide metadata (root shard), so no shard selector is needed.
    const { data, error } = useAdminQuery<WorkflowsResult>(ADMIN_FUNCTIONS.listWorkflows, {});

    const [selectedExport, setSelectedExport] = useState("");
    const [instanceIdInput, setInstanceIdInput] = useState("");
    const [paramsText, setParamsText] = useState("");
    const [starting, setStarting] = useState(false);
    const [startError, setStartError] = useState<null | string>(null);

    const [instances, setInstances] = useState<ObservedInstance[]>([]);
    const [refreshingId, setRefreshingId] = useState<null | string>(null);

    const loaded = data !== undefined;
    const workflows: WorkflowMetadata[] = Array.isArray(data?.workflows)
        ? [...data.workflows].toSorted((a, b) => a.exportName.localeCompare(b.exportName))
        : [];

    // Derive the effective selection rather than syncing it in an effect: fall
    // back to the first declared workflow until the user picks one (and re-default
    // if the current pick disappears after a codegen).
    const selectedExportName = effectiveExportName(workflows, selectedExport);

    // The metadata row for the active selection — its deployed `name` is what the
    // REST instance-history proxy addresses.
    const selectedWorkflow = workflows.find((workflow) => workflow.exportName === selectedExportName);

    // Merge a freshly observed instance into the table, replacing any prior row
    // for the same (workflow, id) so a refresh updates in place rather than dupes.
    const upsertInstance = (next: ObservedInstance): void => {
        setInstances((previous) => {
            const rest = previous.filter((entry) => !(entry.exportName === next.exportName && entry.id === next.id));

            return [next, ...rest];
        });
    };

    const start = async (): Promise<void> => {
        const exportName = selectedExportName;

        if (exportName === "") {
            return;
        }

        let parameters: unknown;
        const trimmed = paramsText.trim();

        if (trimmed !== "") {
            try {
                parameters = JSON.parse(trimmed);
            } catch {
                setStartError(t("Params must be valid JSON"));

                return;
            }
        }

        setStarting(true);
        setStartError(null);

        try {
            const id = instanceIdInput.trim();
            const result = (await client.query(
                CREATE_WORKFLOW_INSTANCE,
                { exportName, id: id === "" ? undefined : id, params: parameters },
                callOptions(""),
            )) as CreateWorkflowInstanceResult;

            upsertInstance({ exportName, id: result.id, status: result.status });
            setInstanceIdInput("");
        } catch (error_: unknown) {
            setStartError(errorMessage(error_));
        }

        setStarting(false);
    };

    const startInstance = (): void => {
        fireAndForget(start());
    };

    const refreshInstance = async (exportName: string, id: string): Promise<void> => {
        setRefreshingId(id);

        try {
            const result = (await client.query(GET_WORKFLOW_INSTANCE_STATUS, { exportName, id }, callOptions(""))) as WorkflowInstanceStatusResult;

            upsertInstance({ error: result.error, exportName, id: result.id, output: result.output, status: result.status });
        } catch (error_: unknown) {
            setStartError(errorMessage(error_));
        }

        setRefreshingId(null);
    };

    const onSelectedExportChange = (event: ChangeEvent<HTMLSelectElement>): void => {
        setSelectedExport(event.target.value);
    };

    const onInstanceIdChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setInstanceIdInput(event.target.value);
    };

    const onParamsChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
        setParamsText(event.target.value);
    };

    const onRefreshClick = (event: MouseEvent<HTMLButtonElement>): void => {
        const { export: exportName, id } = event.currentTarget.dataset;

        if (exportName !== undefined && id !== undefined) {
            fireAndForget(refreshInstance(exportName, id));
        }
    };

    return (
        <div className="flex flex-col gap-6" data-testid="lunora-workflows-panel">
            {error !== null && (
                <p className="text-sm text-destructive" data-testid="workflows-error" role="alert">
                    {error}
                </p>
            )}

            <p className="text-sm text-muted-foreground">
                {t(
                    "Workflows are declared in code with defineWorkflow and run as durable Cloudflare Workflows. Start an instance and observe its status below.",
                )}
            </p>

            {loaded && workflows.length === 0 ? (
                <EmptyState
                    description={t("No defineWorkflow is declared in lunora/workflows.ts in this deployment. Add one to run a durable, multi-step workflow.")}
                    testId="workflows-empty"
                    title={t("No workflows defined")}
                />
            ) : (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="workflows-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("Export")}</TableHead>
                                    <TableHead>{t("Name")}</TableHead>
                                    <TableHead>{t("Class")}</TableHead>
                                    <TableHead>{t("Binding")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {workflows.map((workflow) => (
                                    <TableRow data-testid={`workflows-row-${workflow.exportName}`} key={workflow.exportName}>
                                        <TableCell className="font-mono text-xs">{workflow.exportName}</TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">{workflow.name}</TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">{workflow.className}</TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">{workflow.binding}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}

            {workflows.length > 0 && (
                <div className="flex flex-col gap-3" data-testid="workflows-start">
                    <h3 className="text-sm font-medium">{t("Start instance")}</h3>

                    {startError !== null && (
                        <p className="text-sm text-destructive" data-testid="workflows-start-error" role="alert">
                            {startError}
                        </p>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                        <select
                            aria-label={t("Workflow")}
                            className="h-8 rounded-md border border-input bg-transparent px-2.5 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
                            data-testid="workflows-start-select"
                            onChange={onSelectedExportChange}
                            value={selectedExportName}
                        >
                            {workflows.map((workflow) => (
                                <option key={workflow.exportName} value={workflow.exportName}>
                                    {workflow.exportName}
                                </option>
                            ))}
                        </select>

                        <Input
                            aria-label={t("Instance id (optional)")}
                            className="max-w-48"
                            data-testid="workflows-start-id"
                            onChange={onInstanceIdChange}
                            placeholder={t("Instance id (optional)")}
                            value={instanceIdInput}
                        />

                        <Button data-testid="workflows-start-button" disabled={starting || selectedExportName === ""} onClick={startInstance}>
                            {starting ? t("Starting…") : t("Start instance")}
                        </Button>
                    </div>

                    <Textarea
                        aria-label={t("Params (JSON)")}
                        className="font-mono"
                        data-testid="workflows-start-params"
                        onChange={onParamsChange}
                        placeholder={t("Params (JSON, optional)")}
                        value={paramsText}
                    />
                </div>
            )}

            {instances.length > 0 && (
                <div className="flex flex-col gap-3" data-testid="workflows-instances">
                    <h3 className="text-sm font-medium">{t("Instances")}</h3>

                    <Card className="overflow-hidden py-0">
                        <CardContent className="px-0">
                            <Table data-testid="workflows-instances-table">
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t("Workflow")}</TableHead>
                                        <TableHead>{t("Instance id")}</TableHead>
                                        <TableHead>{t("Status")}</TableHead>
                                        <TableHead>{t("Output")}</TableHead>
                                        <TableHead />
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {instances.map((instance) => (
                                        <TableRow data-testid={`workflows-instance-${instance.id}`} key={`${instance.exportName}:${instance.id}`}>
                                            <TableCell className="font-mono text-xs">{instance.exportName}</TableCell>
                                            <TableCell className="font-mono text-xs text-muted-foreground">{instance.id}</TableCell>
                                            <TableCell className="font-mono text-xs">{instance.status}</TableCell>
                                            <TableCell className="font-mono text-xs text-muted-foreground">{formatPayload(instance)}</TableCell>
                                            <TableCell>
                                                <Button
                                                    data-export={instance.exportName}
                                                    data-id={instance.id}
                                                    data-testid={`workflows-instance-refresh-${instance.id}`}
                                                    disabled={refreshingId === instance.id}
                                                    onClick={onRefreshClick}
                                                    size="xs"
                                                    variant="outline"
                                                >
                                                    {refreshingId === instance.id ? t("Refreshing…") : t("Refresh")}
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </CardContent>
                    </Card>
                </div>
            )}

            {selectedWorkflow !== undefined && <WorkflowInstanceHistory workflowName={selectedWorkflow.name} />}
        </div>
    );
};

export default WorkflowsPanel;
