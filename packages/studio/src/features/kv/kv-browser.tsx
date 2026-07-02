import type { KvKeyEntry, KvNamespaceSummary } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useReducer, useState } from "react";

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

/** Format a KV expiration (Unix seconds) as an ISO string, or an em dash when unset. */
const formatExpiration = (expiration: number | undefined): string => (expiration === undefined ? "—" : new Date(expiration * 1000).toISOString());

// --- value editor: one reducer for the read → edit → write lifecycle so a
// single logical transition (e.g. "loaded") is one render, not five. ---

interface ValueState {
    busy: "" | "deleting" | "saving";
    editedValue: string;
    loadError: null | string;
    loading: boolean;
    metadata: unknown;
    value: null | string;
    writeError: null | string;
}

type ValueAction =
    | { error: string; type: "loadFailed" | "writeFailed" }
    | { metadata: unknown; type: "loaded"; value: null | string }
    | { type: "deleteStart" | "saveOk" | "saveStart" }
    | { type: "edit"; value: string };

const INITIAL_VALUE_STATE: ValueState = { busy: "", editedValue: "", loadError: null, loading: true, metadata: null, value: null, writeError: null };

const valueReducer = (state: ValueState, action: ValueAction): ValueState => {
    switch (action.type) {
        case "deleteStart": {
            return { ...state, busy: "deleting", writeError: null };
        }
        case "edit": {
            return { ...state, editedValue: action.value };
        }
        case "loaded": {
            return { ...state, editedValue: action.value ?? "", loading: false, metadata: action.metadata, value: action.value };
        }
        case "loadFailed": {
            return { ...state, loadError: action.error, loading: false };
        }
        case "saveOk": {
            return { ...state, busy: "", value: state.editedValue };
        }
        case "saveStart": {
            return { ...state, busy: "saving", writeError: null };
        }
        case "writeFailed": {
            return { ...state, busy: "", writeError: action.error };
        }
        default: {
            return state;
        }
    }
};

/**
 * Value view/editor for a single KV key. The parent keys this on
 * `namespace:name`, so selecting a different key remounts it — the editor resets
 * from `INITIAL_VALUE_STATE` rather than reset-in-effect. Reads the value +
 * metadata on mount; saves the edited value or deletes the key.
 */
const KvValueEditor = ({
    expiration,
    keyName,
    namespace,
    onDeleted,
}: {
    readonly expiration?: number;
    readonly keyName: string;
    readonly namespace: string;
    readonly onDeleted: (name: string) => void;
}): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [state, dispatch] = useReducer(valueReducer, INITIAL_VALUE_STATE);

    useEffect(() => {
        const token = { cancelled: false };

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const result = await client.getKvValue({ key: keyName, namespace });

                    if (!token.cancelled) {
                        dispatch({ metadata: result.metadata, type: "loaded", value: result.value });
                    }
                } catch (error_) {
                    if (!token.cancelled) {
                        dispatch({ error: errorMessage(error_), type: "loadFailed" });
                    }
                }
            })(),
        );

        return () => {
            token.cancelled = true;
        };
    }, [client, namespace, keyName]);

    const onEditedValueChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
        dispatch({ type: "edit", value: event.target.value });
    };

    const onSave = (): void => {
        dispatch({ type: "saveStart" });

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    // Re-send the loaded metadata + the key's absolute expiration so
                    // the save preserves them — a bare value PUT would clear metadata
                    // and drop the TTL (KV `put` replaces the whole entry).
                    await client.putKvValue({ expiration, key: keyName, metadata: state.metadata ?? undefined, namespace, value: state.editedValue });
                    dispatch({ type: "saveOk" });
                } catch (error_) {
                    dispatch({ error: errorMessage(error_), type: "writeFailed" });
                }
            })(),
        );
    };

    const onDelete = (): void => {
        dispatch({ type: "deleteStart" });

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    await client.deleteKvKey({ key: keyName, namespace });
                    onDeleted(keyName);
                } catch (error_) {
                    dispatch({ error: errorMessage(error_), type: "writeFailed" });
                }
            })(),
        );
    };

    return (
        <section className="border border-border bg-card p-3" data-testid="kv-value-section">
            <p className="mb-2 font-mono text-xs text-muted-foreground" data-testid="kv-selected-key">
                {keyName}
            </p>

            {state.loadError !== null && (
                <p className="mb-2 text-sm text-destructive" data-testid="kv-value-error" role="alert">
                    {state.loadError}
                </p>
            )}

            {state.loading && (
                <p className="text-sm text-muted-foreground" data-testid="kv-value-loading">
                    {t("Loading…")}
                </p>
            )}

            {!state.loading && state.value !== null && (
                <>
                    <textarea
                        aria-label={t("KV value")}
                        className="mb-3 min-h-[8rem] w-full rounded border border-border bg-muted/30 p-2 font-mono text-xs"
                        data-testid="kv-value-editor"
                        onChange={onEditedValueChange}
                        value={state.editedValue}
                    />

                    {state.metadata !== null && (
                        <p className="mb-3 text-xs text-muted-foreground" data-testid="kv-metadata">
                            {t("Metadata")}: <span className="font-mono">{formatCell(state.metadata)}</span>
                        </p>
                    )}

                    <div className="flex flex-wrap gap-2">
                        <Button data-testid="kv-save-btn" disabled={state.busy !== ""} onClick={onSave}>
                            {state.busy === "saving" ? t("Saving…") : t("Save")}
                        </Button>
                        <Button data-testid="kv-delete-btn" disabled={state.busy !== ""} onClick={onDelete} variant="destructive">
                            {state.busy === "deleting" ? t("Deleting…") : t("Delete")}
                        </Button>
                    </div>

                    {state.writeError !== null && (
                        <p className="mt-2 text-sm text-destructive" data-testid="kv-save-error" role="alert">
                            {state.writeError}
                        </p>
                    )}
                </>
            )}

            {!state.loading && state.value === null && state.loadError === null && (
                <p className="text-sm text-muted-foreground" data-testid="kv-absent">
                    {t("Key is absent or has no value.")}
                </p>
            )}
        </section>
    );
};

// --- key list: one reducer for the paginated, prefix-filtered listing. The
// `appliedPrefix` lives here (not a bare useState) because it drives the load
// effect; the prefix input is a separate, display-only field. ---

interface KeyListState {
    appliedPrefix: string;
    cursor: null | string;
    keys: KvKeyEntry[] | null;
    listComplete: boolean;
    loadError: null | string;
    loading: boolean;
    prefixInput: string;
    selectedKey: null | string;
}

type KeyListAction =
    | { cursor: null | string; keys: KvKeyEntry[]; listComplete: boolean; type: "appendPage" | "firstPage" }
    | { error: string; type: "loadFailed" }
    | { name: string; type: "keyDeleted" }
    | { name: null | string; type: "selectKey" }
    | { type: "applyFilter" | "loadStart" }
    | { type: "prefixInput"; value: string };

const INITIAL_KEY_LIST_STATE: KeyListState = {
    appliedPrefix: "",
    cursor: null,
    keys: null,
    listComplete: false,
    loadError: null,
    loading: false,
    prefixInput: "",
    selectedKey: null,
};

const keyListReducer = (state: KeyListState, action: KeyListAction): KeyListState => {
    switch (action.type) {
        case "appendPage": {
            return { ...state, cursor: action.cursor, keys: [...(state.keys ?? []), ...action.keys], listComplete: action.listComplete, loading: false };
        }
        case "applyFilter": {
            return { ...state, appliedPrefix: state.prefixInput, selectedKey: null };
        }
        case "firstPage": {
            return { ...state, cursor: action.cursor, keys: action.keys, listComplete: action.listComplete, loading: false };
        }
        case "keyDeleted": {
            return { ...state, keys: state.keys === null ? null : state.keys.filter((entry) => entry.name !== action.name), selectedKey: null };
        }
        case "loadFailed": {
            return { ...state, loadError: action.error, loading: false };
        }
        case "loadStart": {
            return { ...state, loadError: null, loading: true };
        }
        case "prefixInput": {
            return { ...state, prefixInput: action.value };
        }
        case "selectKey": {
            return { ...state, selectedKey: action.name };
        }
        default: {
            return state;
        }
    }
};

/**
 * Key list for one namespace. The parent keys this on the namespace, so
 * switching namespaces remounts it (state resets from `INITIAL_KEY_LIST_STATE`).
 * Loads the first page on mount and whenever the applied prefix changes — the
 * prefix input is applied only on the explicit "Filter" action, not per
 * keystroke — and paginates with "Load more".
 */
const KvKeyList = ({ namespace }: { readonly namespace: string }): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [state, dispatch] = useReducer(keyListReducer, INITIAL_KEY_LIST_STATE);
    const { appliedPrefix, cursor, keys, listComplete, loadError, loading, prefixInput, selectedKey } = state;

    useEffect(() => {
        const token = { cancelled: false };

        fireAndForget(
            (async (): Promise<void> => {
                dispatch({ type: "loadStart" });

                try {
                    const result = await client.listKvKeys({
                        limit: DEFAULT_PAGE_SIZE,
                        namespace,
                        prefix: appliedPrefix === "" ? undefined : appliedPrefix,
                    });

                    if (!token.cancelled) {
                        dispatch({ cursor: result.cursor ?? null, keys: result.keys, listComplete: result.listComplete, type: "firstPage" });
                    }
                } catch (error_) {
                    if (!token.cancelled) {
                        dispatch({ error: errorMessage(error_), type: "loadFailed" });
                    }
                }
            })(),
        );

        return () => {
            token.cancelled = true;
        };
    }, [client, namespace, appliedPrefix]);

    const onPrefixChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        dispatch({ type: "prefixInput", value: event.target.value });
    };

    const onFilter = (): void => {
        dispatch({ type: "applyFilter" });
    };

    const onSelectKey = (event: React.MouseEvent<HTMLTableRowElement>): void => {
        dispatch({ name: event.currentTarget.dataset.key ?? null, type: "selectKey" });
    };

    const onLoadMore = (): void => {
        if (cursor === null) {
            return;
        }

        dispatch({ type: "loadStart" });

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const result = await client.listKvKeys({
                        cursor,
                        limit: DEFAULT_PAGE_SIZE,
                        namespace,
                        prefix: appliedPrefix === "" ? undefined : appliedPrefix,
                    });

                    dispatch({ cursor: result.cursor ?? null, keys: result.keys, listComplete: result.listComplete, type: "appendPage" });
                } catch (error_) {
                    dispatch({ error: errorMessage(error_), type: "loadFailed" });
                }
            })(),
        );
    };

    const onKeyDeleted = (name: string): void => {
        dispatch({ name, type: "keyDeleted" });
    };

    return (
        <>
            <section className="border border-border bg-card p-3" data-testid="kv-keys-section">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Input
                        aria-label={t("Filter keys by prefix")}
                        className="min-w-[16rem] flex-1"
                        data-testid="kv-prefix-input"
                        onChange={onPrefixChange}
                        placeholder={t("Filter by prefix…")}
                        value={prefixInput}
                    />
                    <Button data-testid="kv-filter-btn" disabled={loading} onClick={onFilter}>
                        {t("Filter")}
                    </Button>
                </div>

                {loadError !== null && (
                    <p className="text-sm text-destructive" data-testid="kv-keys-error" role="alert">
                        {loadError}
                    </p>
                )}

                {keys !== null && keys.length === 0 && !loading && (
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
                                            <TableCell className="tabular-nums text-xs">{formatExpiration(entry.expiration)}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </CardContent>
                    </Card>
                )}

                {!listComplete && cursor !== null && (
                    <div className="mt-2">
                        <Button data-testid="kv-load-more" disabled={loading} onClick={onLoadMore} variant="outline">
                            {loading ? t("Loading…") : t("Load more")}
                        </Button>
                    </div>
                )}
            </section>

            {selectedKey !== null && (
                <KvValueEditor
                    expiration={keys?.find((entry) => entry.name === selectedKey)?.expiration}
                    key={`${namespace}:${selectedKey}`}
                    keyName={selectedKey}
                    namespace={namespace}
                    onDeleted={onKeyDeleted}
                />
            )}
        </>
    );
};

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

            {selectedNs !== null && <KvKeyList key={selectedNs} namespace={selectedNs} />}
        </div>
    );
};

export type { KvBrowserProps };
