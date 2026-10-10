import { useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import { api } from "../../lunora/_generated/api";
import type { CatalogForm } from "../catalog/artifact";
import { AsyncList } from "./AsyncList";
import { canManage } from "./boxes";
import { CatalogInstallForm } from "./CatalogInstallForm";
import { COLUMN_LABEL } from "./section-classes";
import { FormError, Row, RowActions, RowList, StatusBadge } from "./section-ui";
import type { OrgId } from "./types";
import { useMyRole } from "./use-boxes";

/** Upper bound on the browse request, so a wedged route can't leave the list spinning. */
const BROWSE_TIMEOUT_MS = 15_000;

interface CatalogInstall {
    deploymentId: string;
    projectId: string;
    version: string;
}

interface CatalogAppView {
    form: CatalogForm;
    installs: CatalogInstall[];
    name: string;
    slug: string;
    summary?: string;
    version: string;
}

/** An app the index lists but the browse cannot offer, with the reason it was left out. */
interface CatalogSkipped {
    reason: string;
    slug: string;
    version: string;
}

interface CatalogPayload {
    apps: CatalogAppView[];
    skipped: CatalogSkipped[];
}

const fetchCatalog = async (organizationId: OrgId): Promise<CatalogPayload> => {
    const response = await fetch(`/v1/catalog?organizationId=${encodeURIComponent(organizationId)}`, {
        credentials: "include",
        signal: AbortSignal.timeout(BROWSE_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as { apps?: CatalogAppView[]; error?: string; skipped?: CatalogSkipped[] } | null;

    if (!response.ok || !payload?.apps) {
        throw new Error(payload?.error ?? `could not load the catalog (HTTP ${String(response.status)})`);
    }

    return { apps: payload.apps, skipped: payload.skipped ?? [] };
};

interface CatalogRowProps {
    app: CatalogAppView;
    canInstall: boolean;
    onInstall: (slug: string) => void;
    projectName: (projectId: string) => string;
}

const CatalogRow = ({ app, canInstall, onInstall, projectName }: CatalogRowProps): ReactElement => {
    const handleInstall = (): void => {
        onInstall(app.slug);
    };

    return (
        <Row>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-medium">
                    {app.name} <span className={cn(COLUMN_LABEL, "text-muted-foreground")}>v{app.version}</span>
                </span>
                {app.summary ? <span className="truncate text-muted-foreground">{app.summary}</span> : null}
                <span className="flex flex-wrap gap-1 pt-1">
                    {app.installs.map((install) => (
                        <StatusBadge key={install.projectId}>
                            {projectName(install.projectId)} · v{install.version}
                        </StatusBadge>
                    ))}
                </span>
            </span>
            <RowActions>
                {canInstall ? (
                    <Button onClick={handleInstall} size="sm" type="button" variant="ghost">
                        Install
                    </Button>
                ) : null}
            </RowActions>
        </Row>
    );
};

interface CatalogListProps {
    apps: CatalogAppView[] | undefined;
    canInstall: boolean;
    onInstall: (slug: string) => void;
    projectName: (projectId: string) => string;
}

const CatalogList = ({ apps, canInstall, onInstall, projectName }: CatalogListProps): ReactElement => (
    <AsyncList
        empty="No apps in the catalog yet."
        render={(rows) => (
            <RowList>
                {rows.map((app) => (
                    <CatalogRow app={app} canInstall={canInstall} key={app.slug} onInstall={onInstall} projectName={projectName} />
                ))}
            </RowList>
        )}
        rows={apps}
    />
);

/** Apps the index lists but the browse leaves out, each with its reason, so a broken app is not silently absent. */
const SkippedList = ({ skipped }: { skipped: CatalogSkipped[] }): ReactElement | null => {
    if (skipped.length === 0) {
        return null;
    }

    return (
        <div className="mt-6 flex flex-col gap-2">
            <p className={cn(COLUMN_LABEL, "text-muted-foreground")}>Not installable</p>
            <RowList>
                {skipped.map((entry) => (
                    <Row key={`${entry.slug}@${entry.version}`}>
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="truncate font-medium">
                                {entry.slug} <span className={cn(COLUMN_LABEL, "text-muted-foreground")}>v{entry.version}</span>
                            </span>
                            <span className="text-muted-foreground">{entry.reason}</span>
                        </span>
                    </Row>
                ))}
            </RowList>
        </div>
    );
};

/**
 * Cloud "Catalog": the apps published to the official catalog, and the org's
 * projects that already run each one. Installing an app deploys it into a chosen
 * project from the values its form asks for. Secrets are sealed by the server and
 * never shown again; an install reports only the names it generated.
 */
export const CatalogSection = ({ organizationId }: { organizationId: OrgId }): ReactElement => {
    const projects = useQuery(api.projects.listByOrg, { organizationId });
    const role = useMyRole(organizationId);
    const [catalog, setCatalog] = useState<CatalogPayload | undefined>(undefined);
    const [loadError, setLoadError] = useState<null | string>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const [openSlug, setOpenSlug] = useState<null | string>(null);

    useEffect(() => {
        let active = true;

        const load = async (): Promise<void> => {
            try {
                const loaded = await fetchCatalog(organizationId);

                if (active) {
                    setCatalog(loaded);
                    setLoadError(null);
                }
            } catch (error: unknown) {
                if (active) {
                    setLoadError(error instanceof Error ? error.message : "could not load the catalog");
                }
            }
        };

        void load();

        return () => {
            active = false;
        };
    }, [organizationId, reloadKey]);

    // Installing is a manager action; until the roster answers the role is unknown and the action stays hidden.
    const canInstall = canManage(role);
    const projectName = (projectId: string): string => projects?.find((project) => project._id === projectId)?.name ?? "removed project";
    const openApp = catalog?.apps.find((app) => app.slug === openSlug);

    const handleInstall = (slug: string): void => {
        setOpenSlug(slug);
    };

    const handleClose = (): void => {
        setOpenSlug(null);
    };

    const handleInstalled = (): void => {
        setReloadKey((key) => key + 1);
    };

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <CardHeader>
                    <CardTitle>Catalog</CardTitle>
                    <CardDescription>Apps published to the official catalog. Install one into a project of this organization.</CardDescription>
                </CardHeader>
                <CardContent>
                    <CatalogList apps={catalog?.apps} canInstall={canInstall} onInstall={handleInstall} projectName={projectName} />
                    <SkippedList skipped={catalog?.skipped ?? []} />
                    <FormError message={loadError} />
                </CardContent>
            </Card>

            {openApp && canInstall ? (
                <Card>
                    <CardHeader>
                        <CardTitle>Install {openApp.name}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <CatalogInstallForm
                            form={openApp.form}
                            key={openApp.slug}
                            onClose={handleClose}
                            onInstalled={handleInstalled}
                            organizationId={organizationId}
                            projects={projects ?? []}
                            slug={openApp.slug}
                        />
                    </CardContent>
                </Card>
            ) : null}
        </div>
    );
};
