import type { KvKeyEntry } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useReducer, useState } from "react";

import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget } from "../../lib/internal";
import KvCreateForm from "./kv-create-form";
import { formatExpiration } from "./kv-fields";
import KvValueEditor from "./kv-value-editor";

/** Default page size for the key list. */
const DEFAULT_PAGE_SIZE = 100;

// --- key list: one reducer for the paginated, prefix-filtered listing. The
// `appliedPrefix` lives here (not a bare useState) because it drives the load
// effect; the prefix input is a separate, display-only field. `reloadNonce`
// forces a first-page refetch after a create or bulk delete. ---

interface KeyListState {
    appliedPrefix: string;
    bulk: string[];
    bulkBusy: boolean;
    bulkError: null | string;
    cursor: null | string;
    keys: KvKeyEntry[] | null;
    listComplete: boolean;
    loadError: null | string;
    loading: boolean;
    prefixInput: string;
    reloadNonce: number;
    selectedKey: null | string;
}

type KeyListAction =
    | { cursor: null | string; keys: KvKeyEntry[]; listComplete: boolean; type: "appendPage" | "firstPage" }
    | { deleted: string[]; error: null | string; type: "bulkDeleted" }
    | { error: string; type: "loadFailed" }
    | { name: string; type: "keyDeleted" | "toggleBulk" }
    | { name: null | string; type: "selectKey" }
    | { names: string[]; type: "toggleAllBulk" }
    | { type: "applyFilter" | "bulkDeleteStart" | "loadStart" | "reload" }
    | { type: "prefixInput"; value: string };

const INITIAL_KEY_LIST_STATE: KeyListState = {
    appliedPrefix: "",
    bulk: [],
    bulkBusy: false,
    bulkError: null,
    cursor: null,
    keys: null,
    listComplete: false,
    loadError: null,
    loading: false,
    prefixInput: "",
    reloadNonce: 0,
    selectedKey: null,
};

const keyListReducer = (state: KeyListState, action: KeyListAction): KeyListState => {
    switch (action.type) {
        case "appendPage": {
            return { ...state, cursor: action.cursor, keys: [...(state.keys ?? []), ...action.keys], listComplete: action.listComplete, loading: false };
        }
        case "applyFilter": {
            // Clear the current page too — otherwise the previous prefix's rows stay
            // rendered as if authoritative until the new page resolves. The nonce is
            // what guarantees a page comes back: re-filtering on an UNCHANGED prefix
            // (the first click, or any repeat) leaves `appliedPrefix` referentially
            // equal, so the load effect would not re-run and the cleared list would
            // stay empty for the rest of the session.
            return {
                ...state,
                appliedPrefix: state.prefixInput,
                bulk: [],
                bulkError: null,
                cursor: null,
                keys: null,
                listComplete: false,
                reloadNonce: state.reloadNonce + 1,
                selectedKey: null,
            };
        }
        case "bulkDeleted": {
            // Prune only the keys that actually deleted; any that failed stay
            // selected so the user can retry, and `error` surfaces the failure.
            const removed = new Set(action.deleted);

            return {
                ...state,
                bulk: state.bulk.filter((name) => !removed.has(name)),
                bulkBusy: false,
                bulkError: action.error,
                keys: state.keys === null ? null : state.keys.filter((entry) => !removed.has(entry.name)),
                selectedKey: state.selectedKey !== null && removed.has(state.selectedKey) ? null : state.selectedKey,
            };
        }
        case "bulkDeleteStart": {
            return { ...state, bulkBusy: true, bulkError: null };
        }
        case "firstPage": {
            return { ...state, cursor: action.cursor, keys: action.keys, listComplete: action.listComplete, loading: false };
        }
        case "keyDeleted": {
            return {
                ...state,
                bulk: state.bulk.filter((name) => name !== action.name),
                keys: state.keys === null ? null : state.keys.filter((entry) => entry.name !== action.name),
                selectedKey: null,
            };
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
        case "reload": {
            return { ...state, bulk: [], bulkError: null, reloadNonce: state.reloadNonce + 1, selectedKey: null };
        }
        case "selectKey": {
            return { ...state, selectedKey: action.name };
        }
        case "toggleAllBulk": {
            return { ...state, bulk: action.names };
        }
        case "toggleBulk": {
            return {
                ...state,
                bulk: state.bulk.includes(action.name) ? state.bulk.filter((name) => name !== action.name) : [...state.bulk, action.name],
            };
        }
        default: {
            return state;
        }
    }
};

/**
 * Key list for one namespace. The parent keys this on the namespace, so
 * switching namespaces remounts it (state resets from `INITIAL_KEY_LIST_STATE`).
 * Loads the first page on mount and whenever the applied prefix or reload nonce
 * changes — the prefix input is applied only on the explicit "Filter" action,
 * not per keystroke — paginates with "Load more", and supports creating a key
 * and bulk-deleting selected keys.
 */
const KvKeyList = ({ namespace }: { readonly namespace: string }): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [state, dispatch] = useReducer(keyListReducer, INITIAL_KEY_LIST_STATE);
    const { appliedPrefix, bulk, bulkBusy, bulkError, cursor, keys, listComplete, loadError, loading, prefixInput, reloadNonce, selectedKey } = state;
    const [showCreate, setShowCreate] = useState(false);

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
    }, [client, namespace, appliedPrefix, reloadNonce]);

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

    const onToggleBulk = (name: string): void => {
        dispatch({ name, type: "toggleBulk" });
    };

    const onToggleAll = (checked: boolean): void => {
        dispatch({ names: checked && keys !== null ? keys.map((entry) => entry.name) : [], type: "toggleAllBulk" });
    };

    const onBulkDelete = (): void => {
        if (bulk.length === 0) {
            return;
        }

        const names = [...bulk];

        dispatch({ type: "bulkDeleteStart" });

        fireAndForget(
            (async (): Promise<void> => {
                // `allSettled` so one failed delete doesn't abort the rest; prune only
                // the keys that actually deleted and surface a count for any failures
                // (a destructive op must never look successful when it wasn't).
                const results = await Promise.allSettled(names.map((name) => client.deleteKvKey({ key: name, namespace })));
                const deleted = names.filter((_, index) => results[index]?.status === "fulfilled");
                const failed = names.length - deleted.length;

                dispatch({ deleted, error: failed > 0 ? t("Failed to delete {count} keys.", { count: failed }) : null, type: "bulkDeleted" });
            })(),
        );
    };

    const onCreated = (): void => {
        setShowCreate(false);
        dispatch({ type: "reload" });
    };

    const allSelected = keys !== null && keys.length > 0 && bulk.length === keys.length;
    // A Set, not `bulk.includes` per row: the checkbox below asks once per rendered
    // key, so the array scan made selection quadratic in the page size.
    const bulkSelected = new Set(bulk);

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
                    <Button
                        data-testid="kv-new-key-btn"
                        onClick={() => {
                            setShowCreate((open) => !open);
                        }}
                        variant="outline"
                    >
                        {t("New key")}
                    </Button>
                    {bulk.length > 0 && (
                        <Button data-testid="kv-bulk-delete-btn" disabled={bulkBusy} onClick={onBulkDelete} variant="destructive">
                            {bulkBusy ? t("Deleting…") : t("Delete {count}", { count: bulk.length })}
                        </Button>
                    )}
                </div>

                {bulkError !== null && (
                    <p className="mb-2 text-sm text-destructive" data-testid="kv-bulk-error" role="alert">
                        {bulkError}
                    </p>
                )}

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
                                        <TableHead className="w-10">
                                            <Checkbox
                                                aria-label={t("Select all")}
                                                checked={allSelected}
                                                data-testid="kv-select-all"
                                                onCheckedChange={onToggleAll}
                                            />
                                        </TableHead>
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
                                            <TableCell
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                }}
                                            >
                                                <Checkbox
                                                    aria-label={t("Select {name}", { name: entry.name })}
                                                    checked={bulkSelected.has(entry.name)}
                                                    data-testid={`kv-select-${entry.name}`}
                                                    onCheckedChange={() => {
                                                        onToggleBulk(entry.name);
                                                    }}
                                                />
                                            </TableCell>
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

            <Sheet
                onOpenChange={(open) => {
                    if (!open) {
                        setShowCreate(false);
                    }
                }}
                open={showCreate}
            >
                <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md" data-testid="kv-create-sheet" side="right">
                    <SheetHeader>
                        <SheetTitle>{t("New key")}</SheetTitle>
                    </SheetHeader>
                    <KvCreateForm
                        namespace={namespace}
                        onCancel={() => {
                            setShowCreate(false);
                        }}
                        onCreated={onCreated}
                    />
                </SheetContent>
            </Sheet>

            <Sheet
                onOpenChange={(open) => {
                    if (!open) {
                        dispatch({ name: null, type: "selectKey" });
                    }
                }}
                open={selectedKey !== null}
            >
                <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md" data-testid="kv-editor-sheet" side="right">
                    <SheetHeader>
                        <SheetTitle className="truncate font-mono text-xs">{selectedKey}</SheetTitle>
                    </SheetHeader>
                    {selectedKey !== null && (
                        <KvValueEditor
                            expiration={keys?.find((entry) => entry.name === selectedKey)?.expiration}
                            key={`${namespace}:${selectedKey}`}
                            keyName={selectedKey}
                            namespace={namespace}
                            onDeleted={onKeyDeleted}
                        />
                    )}
                </SheetContent>
            </Sheet>
        </>
    );
};
export default KvKeyList;
