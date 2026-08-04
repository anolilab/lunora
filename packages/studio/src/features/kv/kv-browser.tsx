import type { KvNamespaceSummary } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget } from "../../lib/internal";
import { KvKeyList } from "./kv-key-list";

interface KvBrowserProps {
    /**
     * Load the worker's registered KV namespaces. Defaults to
     * `client.listKvNamespaces`, which hits the admin-gated
     * `GET /_lunora/admin/kv/namespaces` endpoint — so the panel works out of
     * the box under `<LunoraProvider>`, provided the worker is built with a
     * `kvIntrospector` and `adminToken`.
     */
    readonly loadNamespaces?: () => Promise<KvNamespaceSummary[]>;
}

/**
 * Read-write **KV namespace browser**. Lists every Workers KV namespace the
 * worker is built with via `kvIntrospector` and owns the selection; the selected
 * namespace's keys and value editor live in `KvKeyList` / `KvValueEditor`, each
 * keyed on its identity so a selection change remounts (and resets) it.
 */
export const KvBrowser = ({ loadNamespaces }: KvBrowserProps = {}): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [namespaces, setNamespaces] = useState<KvNamespaceSummary[] | null>(null);
    const [nsError, setNsError] = useState<null | string>(null);
    const [selectedNs, setSelectedNs] = useState<null | string>(null);

    // Load the namespace list on mount.
    useEffect(() => {
        const token = { cancelled: false };

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const result = await (loadNamespaces ?? (() => client.listKvNamespaces()))();

                    if (!token.cancelled) {
                        setNamespaces(result);
                        setNsError(null);
                        setSelectedNs((current) => current ?? result[0]?.binding ?? null);
                    }
                } catch (error_) {
                    if (!token.cancelled) {
                        setNamespaces(null);
                        setNsError(errorMessage(error_));
                    }
                }
            })(),
        );

        return () => {
            token.cancelled = true;
        };
    }, [client, loadNamespaces]);

    const onSelectNs = (event: React.MouseEvent<HTMLTableRowElement>): void => {
        setSelectedNs(event.currentTarget.dataset.ns ?? null);
    };

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-kv-browser">
            {nsError !== null && (
                <p className="text-sm text-destructive" data-testid="kv-ns-error" role="alert">
                    {nsError}
                </p>
            )}

            {namespaces !== null && namespaces.length === 0 && (
                <EmptyState
                    description={t("Add a kv_namespaces binding to wrangler.jsonc — it appears here automatically, no wiring needed.")}
                    icon={
                        <svg
                            aria-hidden="true"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.6}
                            viewBox="0 0 24 24"
                        >
                            <path d="M5 5h14v4H5V5Zm0 5h14v4H5v-4Zm0 5h14v4H5v-4Z" />
                        </svg>
                    }
                    testId="kv-empty"
                    title={t("No KV namespaces.")}
                />
            )}

            {namespaces !== null && namespaces.length > 0 && (
                <Card className="overflow-hidden py-0">
                    <CardContent className="px-0">
                        <Table data-testid="kv-namespace-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t("Namespace")}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {namespaces.map((ns) => (
                                    <TableRow
                                        className={ns.binding === selectedNs ? "border-l-2 border-l-royal-amethyst bg-muted/50" : "cursor-pointer"}
                                        data-ns={ns.binding}
                                        data-testid={`kv-ns-row-${ns.binding}`}
                                        key={ns.binding}
                                        onClick={onSelectNs}
                                    >
                                        <TableCell className="font-mono text-xs">{ns.binding}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}

            {selectedNs !== null && <KvKeyList key={selectedNs} namespace={selectedNs} />}
        </div>
    );
};

export type { KvBrowserProps };
