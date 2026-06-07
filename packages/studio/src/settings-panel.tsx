import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { SettingEntry, SettingsResult } from "./admin.js";
import { ADMIN_FUNCTIONS } from "./admin.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table.js";
import { useT } from "./i18n-context.js";
import { adminRef, callOptions, errorMessage, fireAndForget } from "./internal.js";

interface SettingsPanelProps {
    /** Shard key the settings read targets on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const GET_SETTINGS = adminRef(ADMIN_FUNCTIONS.getSettings);

/** Cloudflare dashboard — the infra plane where bindings and secrets are actually edited. */
const CLOUDFLARE_STUDIO_URL = "https://dash.cloudflare.com/?to=/:account/workers-and-pages";

/** Badge tone per setting kind, so secrets read as the most guarded. */
const KIND_VARIANT: Record<SettingEntry["kind"], "destructive" | "outline" | "secondary"> = {
    binding: "outline",
    secret: "destructive",
    var: "secondary",
};

/**
 * Read-only **Settings** view of the deployment's config: the Worker vars,
 * secrets, and bindings exposed via `env`, plus best-effort deploy metadata.
 * Reads the `__cirrus_admin__:getSettings` RPC over the {@link useCirrus} client
 * (gated by the server's `CIRRUS_ADMIN_TOKEN`).
 *
 * Strictly view-only: secret values are masked server-side and never returned
 * raw, and there is no editing here. The infrastructure plane lives in
 * Cloudflare/wrangler — a deep-link to the Cloudflare dashboard is provided so
 * you can edit there. This is a snapshot; press Refresh to re-pull.
 */
export const SettingsPanel = ({ initialShardKey }: SettingsPanelProps): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [result, setResult] = useState<SettingsResult | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [loading, setLoading] = useState<boolean>(false);

    const refresh = useCallback(async (): Promise<void> => {
        setLoading(true);
        setError(null);

        try {
            const settings = (await client.query(GET_SETTINGS, {}, callOptions(initialShardKey ?? ""))) as SettingsResult;

            setResult(settings);
        } catch (error_) {
            setResult(null);
            setError(errorMessage(error_));
        } finally {
            setLoading(false);
        }
    }, [client, initialShardKey]);

    useEffect(() => {
        fireAndForget(refresh());
    }, [refresh]);

    const onRefresh = useCallback((): void => {
        fireAndForget(refresh());
    }, [refresh]);

    const deployRows = useMemo<{ label: string; value: string }[]>(() => {
        const deploy = result?.deploy;

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
    }, [result, t]);

    const settings = result?.settings ?? [];

    return (
        <div className="flex flex-col gap-4" data-testid="cirrus-settings">
            <div className="flex flex-wrap items-center gap-3">
                <Button data-testid="set-refresh" disabled={loading} onClick={onRefresh} size="sm" type="button" variant="outline">
                    {t("Refresh")}
                </Button>
                <a
                    className="text-sm text-primary underline-offset-4 hover:underline"
                    data-testid="set-cf-link"
                    href={CLOUDFLARE_STUDIO_URL}
                    rel="noreferrer"
                    target="_blank"
                >
                    {t("Open in Cloudflare")}
                </a>
            </div>

            <p className="text-sm text-muted-foreground" data-testid="set-readonly-note">
                {t("View-only — values are masked. Edit vars, secrets, and bindings in wrangler or the Cloudflare dashboard.")}
            </p>

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="set-error" role="alert">
                    {error}
                </p>
            )}

            {deployRows.length > 0 && (
                <section className="rounded-md border border-border p-3" data-testid="set-deploy">
                    <h3 className="mb-2 text-sm font-semibold">{t("Deployment")}</h3>
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
                </section>
            )}

            <section className="rounded-md border border-border p-3">
                <h3 className="mb-2 text-sm font-semibold">{t("Environment & bindings")}</h3>

                {error === null && !loading && settings.length === 0 && (
                    <p className="text-sm text-muted-foreground" data-testid="set-empty">
                        {t("No environment variables or bindings.")}
                    </p>
                )}

                {settings.length > 0 && (
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
                )}
            </section>
        </div>
    );
};

export type { SettingsPanelProps };
