import type { ReactElement } from "react";

import { ErrorAlert } from "../../components/error-alert";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import type { TFunction } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";
import type { DeployInfo, SettingEntry, SettingsResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { CLOUDFLARE_WORKERS_URL } from "../../lib/cf-links";

interface SettingsPanelProps {
    /** Shard key the settings read targets on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

/** Badge tone per setting kind, so secrets read as the most guarded. */
const KIND_VARIANT: Record<SettingEntry["kind"], "destructive" | "outline" | "secondary"> = {
    binding: "outline",
    secret: "destructive",
    var: "secondary",
};

/**
 * Read-only **Settings** view of the deployment's config: the Worker vars,
 * secrets, and bindings exposed via `env`, plus best-effort deploy metadata.
 * Reads the `__lunora_admin__:getSettings` RPC via {@link useAdminQuery} (gated
 * by the server's `LUNORA_ADMIN_TOKEN`).
 *
 * Strictly view-only: secret values are masked server-side and never returned
 * raw, and there is no editing here. The infrastructure plane lives in
 * Cloudflare/wrangler — a deep-link to the Cloudflare dashboard is provided so
 * you can edit there. Deployment config is static at runtime (it only changes on
 * redeploy), so this loads once on mount — there is no live channel or poll.
 */
/** The deployment facts that are actually present, as label/value rows. Absent fields are omitted rather than rendered blank. */
const toDeployRows = (deploy: DeployInfo | undefined, t: TFunction): { label: string; value: string }[] => {
    if (deploy === undefined) {
        return [];
    }

    const rows: { label: string; value: string }[] = [];

    if (deploy.workerUrl !== undefined) {
        rows.push({ label: t("URL"), value: deploy.workerUrl });
    }

    if (deploy.environment !== undefined) {
        rows.push({ label: t("Environment"), value: deploy.environment });
    }

    if (deploy.deploymentId !== undefined) {
        rows.push({ label: t("Deployment"), value: deploy.deploymentId });
    }

    if (deploy.versionTag !== undefined) {
        rows.push({ label: t("Version"), value: deploy.versionTag });
    }

    return rows;
};

export const SettingsPanel = ({ initialShardKey }: SettingsPanelProps): ReactElement => {
    const t = useT();

    // Deployment config is static at runtime (it only changes on redeploy), so a
    // plain one-shot read with no live channel.
    const {
        data: result,
        error,
        errorSource,
        isLoading: loading,
    } = useAdminQuery<SettingsResult>(ADMIN_FUNCTIONS.getSettings, {}, { shardKey: initialShardKey ?? "" });

    const deployRows = toDeployRows(result?.deploy, t);

    const settings = result?.settings ?? [];

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-settings">
            <div className="flex flex-wrap items-center gap-3">
                <a
                    className="text-sm text-primary underline-offset-4 hover:underline"
                    data-testid="set-cf-link"
                    href={CLOUDFLARE_WORKERS_URL}
                    rel="noreferrer"
                    target="_blank"
                >
                    {t("Open in Cloudflare")}
                </a>
            </div>

            <p className="text-sm text-muted-foreground" data-testid="set-readonly-note">
                {t("View-only — values are masked. Edit vars, secrets, and bindings in wrangler or the Cloudflare dashboard.")}
            </p>

            {error !== null && <ErrorAlert error={errorSource} testId="set-error" />}

            {deployRows.length > 0 && (
                <Card className="py-0" data-testid="set-deploy">
                    <header className="border-b border-border px-4 py-3">
                        <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Deployment")}</span>
                    </header>
                    <CardContent className="py-3">
                        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                            {deployRows.map((row) => (
                                <div className="contents" data-testid="set-deploy-row" key={row.label}>
                                    <dt className="text-muted-foreground">{row.label}</dt>
                                    <dd className="truncate font-mono text-xs" title={row.value}>
                                        {row.value}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </CardContent>
                </Card>
            )}

            <Card className="py-0">
                <header className="border-b border-border px-4 py-3">
                    <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Environment & bindings")}</span>
                </header>

                {error === null && !loading && settings.length === 0 && (
                    <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="set-empty">
                        {t("No environment variables or bindings.")}
                    </p>
                )}

                {settings.length > 0 && (
                    <CardContent className="px-0 py-0">
                        <Table data-testid="set-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("name")}</TableHead>
                                    <TableHead>{t("kind")}</TableHead>
                                    <TableHead>{t("value")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {settings.map((entry) => (
                                    <TableRow data-testid="set-row" key={entry.name}>
                                        <TableCell className="font-mono text-xs font-medium">{entry.name}</TableCell>
                                        <TableCell>
                                            <Badge variant={KIND_VARIANT[entry.kind]}>{entry.bindingType ?? entry.kind}</Badge>
                                        </TableCell>
                                        <TableCell className="max-w-[28ch] truncate font-mono text-xs text-muted-foreground">
                                            {entry.value ?? <span className="text-muted-foreground">—</span>}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                )}
            </Card>
        </div>
    );
};

export type { SettingsPanelProps };
