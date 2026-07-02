import type { KvKeyEntry, KvNamespaceSummary } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget, formatCell } from "../../lib/internal";

interface KvBrowserProps {
    /**
     * Load the worker's registered KV namespaces. Defaults to
     * `client.listKvNamespaces`, which hits the admin-gated
     * `GET /_lunora/admin/kv/namespaces` endpoint — so the panel works out of
     * the box under `&lt;LunoraProvider>`, provided the worker is built with a
     * `kvIntrospector` and `adminToken`.
     */
    readonly loadNamespaces?: () => Promise<KvNamespaceSummary[]>;
}

/** Default page size for the key list. */
const DEFAULT_PAGE_SIZE = 100;

/** Drop the entry named `name` from a possibly-null key list (used to prune a deleted key). */
const withoutKey = (keys: KvKeyEntry[] | null, name: string): KvKeyEntry[] | null => (keys === null ? null : keys.filter((entry) => entry.name !== name));

/**
 * Read-write **KV namespace browser**. Lists every Workers KV namespace the
 * worker is built with via `kvIntrospector`. Selecting a namespace shows its
 * keys (prefix-filtered, paginated with "Load more"). Selecting a key reads its
 * value and metadata; the value is editable and can be saved back or deleted.
 */
export const KvBrowser = ({ loadNamespaces }: KvBrowserProps = {}): ReactElement => {
    const client = useLunora();
    const t = useT();

    // --- namespace list state ---
    const [namespaces, setNamespaces] = useState<KvNamespaceSummary[] | null>(null);
    const [nsError, setNsError] = useState<null | string>(null);
    const [selectedNs, setSelectedNs] = useState<null | string>(null);

    // --- key list state ---
    const [prefix, setPrefix] = useState<string>("");
    const [keys, setKeys] = useState<KvKeyEntry[] | null>(null);
    const [keyCursor, setKeyCursor] = useState<null | string>(null);
    const [keyListComplete, setKeyListComplete] = useState<boolean>(false);
    const [keysLoading, setKeysLoading] = useState<boolean>(false);
    const [keysError, setKeysError] = useState<null | string>(null);
    const [selectedKey, setSelectedKey] = useState<null | string>(null);

    // --- value state ---
    const [value, setValue] = useState<null | string>(null);
    const [metadata, setMetadata] = useState<unknown>(null);
    const [valueLoading, setValueLoading] = useState<boolean>(false);
    const [valueError, setValueError] = useState<null | string>(null);
    const [editedValue, setEditedValue] = useState<string>("");
    const [saving, setSaving] = useState<boolean>(false);
    const [deleting, setDeleting] = useState<boolean>(false);
    const [saveError, setSaveError] = useState<null | string>(null);

    // Load namespace list on mount.
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

    // Load first page of keys whenever the selected namespace or prefix changes.
    useEffect(() => {
        if (selectedNs === null) {
            return undefined;
        }

        const token = { cancelled: false };

        fireAndForget(
            (async (): Promise<void> => {
                // Clear the previous namespace's view and show the spinner before the
                // fetch. Done inside the async body (not the effect body) so it reads
                // as part of the load rather than an unconditional mount-time reset.
                setKeys(null);
                setKeyCursor(null);
                setKeyListComplete(false);
                setKeysLoading(true);
                setKeysError(null);
                setSelectedKey(null);
                setValue(null);
                setMetadata(null);
                setEditedValue("");

                try {
                    const result = await client.listKvKeys({
                        limit: DEFAULT_PAGE_SIZE,
                        namespace: selectedNs,
                        prefix: prefix === "" ? undefined : prefix,
                    });

                    if (!token.cancelled) {
                        setKeys(result.keys);
                        setKeyCursor(result.cursor ?? null);
                        setKeyListComplete(result.listComplete);
                    }
                } catch (error_) {
                    if (!token.cancelled) {
                        setKeysError(errorMessage(error_));
                    }
                } finally {
                    if (!token.cancelled) {
                        setKeysLoading(false);
                    }
                }
            })(),
        );

        return () => {
            token.cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- prefix is applied on explicit "Filter" action, not on every keystroke
    }, [client, selectedNs]);

    // Load the value + metadata whenever the selected key changes.
    useEffect(() => {
        if (selectedNs === null || selectedKey === null) {
            return undefined;
        }

        const token = { cancelled: false };

        fireAndForget(
            (async (): Promise<void> => {
                setValueLoading(true);
                setValueError(null);
                setSaveError(null);

                try {
                    const result = await client.getKvValue({ key: selectedKey, namespace: selectedNs });

                    if (!token.cancelled) {
                        setValue(result.value);
                        setMetadata(result.metadata);
                        setEditedValue(result.value ?? "");
                        setValueError(null);
                    }
                } catch (error_) {
                    if (!token.cancelled) {
                        setValueError(errorMessage(error_));
                    }
                } finally {
                    if (!token.cancelled) {
                        setValueLoading(false);
                    }
                }
            })(),
        );

        return () => {
            token.cancelled = true;
        };
    }, [client, selectedNs, selectedKey]);

    // --- event handlers ---

    const onSelectNs = (event: React.MouseEvent<HTMLTableRowElement>): void => {
        const binding = event.currentTarget.dataset.ns ?? null;

        setSelectedNs(binding);
        setSelectedKey(null);
        setValue(null);
        setMetadata(null);
        setEditedValue("");
        setPrefix("");
    };

    const onSelectKey = (event: React.MouseEvent<HTMLTableRowElement>): void => {
        setSelectedKey(event.currentTarget.dataset.key ?? null);
        setSaveError(null);
    };

    const onPrefixChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        setPrefix(event.target.value);
    };

    const onFilter = (): void => {
        if (selectedNs === null) {
            return;
        }

        setKeys(null);
        setKeyCursor(null);
        setKeyListComplete(false);
        setKeysLoading(true);
        setKeysError(null);
        setSelectedKey(null);
        setValue(null);
        setMetadata(null);
        setEditedValue("");

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const result = await client.listKvKeys({
                        limit: DEFAULT_PAGE_SIZE,
                        namespace: selectedNs,
                        prefix: prefix === "" ? undefined : prefix,
                    });

                    setKeys(result.keys);
                    setKeyCursor(result.cursor ?? null);
                    setKeyListComplete(result.listComplete);
                } catch (error_) {
                    setKeysError(errorMessage(error_));
                } finally {
                    setKeysLoading(false);
                }
            })(),
        );
    };

    const onLoadMore = (): void => {
        if (selectedNs === null || keyCursor === null) {
            return;
        }

        setKeysLoading(true);

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const result = await client.listKvKeys({
                        cursor: keyCursor,
                        limit: DEFAULT_PAGE_SIZE,
                        namespace: selectedNs,
                        prefix: prefix === "" ? undefined : prefix,
                    });

                    setKeys((previous) => [...(previous ?? []), ...result.keys]);
                    setKeyCursor(result.cursor ?? null);
                    setKeyListComplete(result.listComplete);
                } catch (error_) {
                    setKeysError(errorMessage(error_));
                } finally {
                    setKeysLoading(false);
                }
            })(),
        );
    };

    const onEditedValueChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
        setEditedValue(event.target.value);
    };

    const onSave = (): void => {
        if (selectedNs === null || selectedKey === null) {
            return;
        }

        setSaving(true);
        setSaveError(null);

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    await client.putKvValue({ key: selectedKey, namespace: selectedNs, value: editedValue });
                    setValue(editedValue);
                } catch (error_) {
                    setSaveError(errorMessage(error_));
                } finally {
                    setSaving(false);
                }
            })(),
        );
    };

    const onDelete = (): void => {
        if (selectedNs === null || selectedKey === null) {
            return;
        }

        setDeleting(true);
        setSaveError(null);

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    await client.deleteKvKey({ key: selectedKey, namespace: selectedNs });
                    // Remove the deleted key from the list and clear the editor.
                    setKeys((previous) => withoutKey(previous, selectedKey));
                    setSelectedKey(null);
                    setValue(null);
                    setMetadata(null);
                    setEditedValue("");
                } catch (error_) {
                    setSaveError(errorMessage(error_));
                } finally {
                    setDeleting(false);
                }
            })(),
        );
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
                    description={t("Add a Workers KV namespace binding to wrangler.jsonc and wire it through createKvIntrospector to browse it here.")}
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

            {selectedNs !== null && (
                <section className="border border-border bg-card p-3" data-testid="kv-keys-section">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                        <Input
                            className="min-w-[16rem] flex-1"
                            data-testid="kv-prefix-input"
                            onChange={onPrefixChange}
                            placeholder={t("Filter by prefix…")}
                            value={prefix}
                        />
                        <Button data-testid="kv-filter-btn" disabled={keysLoading} onClick={onFilter}>
                            {t("Filter")}
                        </Button>
                    </div>

                    {keysError !== null && (
                        <p className="text-sm text-destructive" data-testid="kv-keys-error" role="alert">
                            {keysError}
                        </p>
                    )}

                    {keys !== null && keys.length === 0 && !keysLoading && (
                        <p className="text-sm text-muted-foreground" data-testid="kv-no-keys">
                            {t("No keys.")}
                        </p>
                    )}

                    {keys !== null && keys.length > 0 && (
                        <Card className="overflow-hidden py-0">
                            <CardContent className="px-0">
                                <Table data-testid="kv-key-table">
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t("Key")}</TableHead>
                                            <TableHead>{t("Expiration")}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {keys.map((entry) => (
                                            <TableRow
                                                className={entry.name === selectedKey ? "border-l-2 border-l-royal-amethyst bg-muted/50" : "cursor-pointer"}
                                                data-key={entry.name}
                                                data-testid={`kv-key-row-${entry.name}`}
                                                key={entry.name}
                                                onClick={onSelectKey}
                                            >
                                                <TableCell className="font-mono text-xs">{entry.name}</TableCell>
                                                <TableCell className="tabular-nums text-xs">
                                                    {entry.expiration === undefined ? "—" : new Date(entry.expiration * 1000).toISOString()}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>
                    )}

                    {!keyListComplete && keyCursor !== null && (
                        <div className="mt-2">
                            <Button data-testid="kv-load-more" disabled={keysLoading} onClick={onLoadMore} variant="outline">
                                {keysLoading ? t("Loading…") : t("Load more")}
                            </Button>
                        </div>
                    )}
                </section>
            )}

            {selectedKey !== null && selectedNs !== null && (
                <section className="border border-border bg-card p-3" data-testid="kv-value-section">
                    <p className="mb-2 font-mono text-xs text-muted-foreground" data-testid="kv-selected-key">
                        {selectedKey}
                    </p>

                    {valueError !== null && (
                        <p className="mb-2 text-sm text-destructive" data-testid="kv-value-error" role="alert">
                            {valueError}
                        </p>
                    )}

                    {valueLoading && (
                        <p className="text-sm text-muted-foreground" data-testid="kv-value-loading">
                            {t("Loading…")}
                        </p>
                    )}

                    {!valueLoading && value !== null && (
                        <>
                            <textarea
                                className="mb-3 min-h-[8rem] w-full rounded border border-border bg-muted/30 p-2 font-mono text-xs"
                                data-testid="kv-value-editor"
                                onChange={onEditedValueChange}
                                value={editedValue}
                            />

                            {metadata !== null && (
                                <p className="mb-3 text-xs text-muted-foreground" data-testid="kv-metadata">
                                    {t("Metadata")}: <span className="font-mono">{formatCell(metadata)}</span>
                                </p>
                            )}

                            <div className="flex flex-wrap gap-2">
                                <Button data-testid="kv-save-btn" disabled={saving || deleting} onClick={onSave}>
                                    {saving ? t("Saving…") : t("Save")}
                                </Button>
                                <Button data-testid="kv-delete-btn" disabled={saving || deleting} onClick={onDelete} variant="destructive">
                                    {deleting ? t("Deleting…") : t("Delete")}
                                </Button>
                            </div>

                            {saveError !== null && (
                                <p className="mt-2 text-sm text-destructive" data-testid="kv-save-error" role="alert">
                                    {saveError}
                                </p>
                            )}
                        </>
                    )}

                    {!valueLoading && value === null && valueError === null && (
                        <p className="text-sm text-muted-foreground" data-testid="kv-absent">
                            {t("Key is absent or has no value.")}
                        </p>
                    )}
                </section>
            )}
        </div>
    );
};

export type { KvBrowserProps };
