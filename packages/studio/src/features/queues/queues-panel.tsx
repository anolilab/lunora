import type { ReactElement } from "react";
import { useMemo } from "react";

import { ErrorAlert } from "../../components/error-alert";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { QueuesResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";

/**
 * The Queues inspector — lists the deployment's declared Cloudflare Queues
 * (`defineQueue`). Per queue it shows the `defineQueue` export, the stable
 * deployed `queues.producers[].queue` name, the consumer mode (push worker vs
 * HTTP pull), the wrangler `Queue` producer binding, and the optional
 * dead-letter queue — statically discovered by `@lunora/codegen` and served by
 * the list-queues admin RPC, so it refreshes on every codegen run (dev: on save;
 * prod: on deploy).
 */
const QueuesPanel = (): ReactElement => {
    const t = useT();

    // Deployment-wide metadata (root shard), so no shard selector needed.
    const { data, error, errorSource } = useAdminQuery<QueuesResult>(ADMIN_FUNCTIONS.listQueues, {});

    const loaded = data !== undefined;
    const queues = useMemo(() => (Array.isArray(data?.queues) ? [...data.queues].toSorted((a, b) => a.exportName.localeCompare(b.exportName)) : []), [data]);

    return (
        <div className="flex flex-col gap-6" data-testid="lunora-queues-panel">
            {error !== null && <ErrorAlert error={errorSource} testId="queues-error" />}

            <p className="text-sm text-muted-foreground">
                {t(
                    "Queues are declared in code with defineQueue. Enqueue from a mutation or action with ctx.queues.<name>.send(...); push consumers process batches in the worker.",
                )}
            </p>

            {loaded && queues.length === 0 ? (
                <EmptyState
                    description={t("No defineQueue is declared in lunora/queues.ts in this deployment. Add one to offload async work to a Cloudflare Queue.")}
                    testId="queues-empty"
                    title={t("No queues defined")}
                />
            ) : (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="queues-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("Export")}</TableHead>
                                    <TableHead>{t("Queue")}</TableHead>
                                    <TableHead>{t("Mode")}</TableHead>
                                    <TableHead>{t("Binding")}</TableHead>
                                    <TableHead>{t("Dead-letter")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {queues.map((queue) => (
                                    <TableRow data-testid={`queues-row-${queue.exportName}`} key={queue.exportName}>
                                        <TableCell className="font-mono text-xs">{queue.exportName}</TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">{queue.name}</TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">{queue.mode}</TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">{queue.binding}</TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground">{queue.deadLetterQueue ?? "—"}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}
        </div>
    );
};

export default QueuesPanel;
