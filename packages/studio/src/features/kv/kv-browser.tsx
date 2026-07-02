import type { KvKeyEntry, KvNamespaceSummary } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useReducer, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Textarea } from "../../components/ui/textarea";
import { useT } from "../../i18n/i18n-context";
import { copyToClipboard, errorMessage, fireAndForget, formatBytes } from "../../lib/internal";

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

/** UTF-8 byte length of a string — KV values are sized in bytes, not code points. */
const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/** Pretty-print `value` when it parses as JSON, else `null`. */
const tryFormatJson = (value: string): null | string => {
    if (value.trim() === "") {
        return null;
    }

    try {
        return JSON.stringify(JSON.parse(value) as unknown, null, 2);
    } catch {
        return null;
    }
};

/** True when `value` is empty or parses as JSON — the guard for saving metadata. */
const isJsonOrEmpty = (value: string): boolean => {
    if (value.trim() === "") {
        return true;
    }

    try {
        JSON.parse(value);

        return true;
    } catch {
        return false;
    }
};

/** Parse a TTL input into a positive integer of seconds, or `undefined` when blank/invalid. */
const parseTtl = (value: string): number | undefined => {
    const trimmed = value.trim();

    if (trimmed === "") {
        return undefined;
    }

    const seconds = Number(trimmed);

    return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : undefined;
};

// --- value editor: one reducer for the read → edit → write lifecycle so a
// single logical transition (e.g. "loaded") is one render, not five. ---

interface ValueState {
    busy: "" | "deleting" | "saving";
    editedMetadata: string;
    editedTtl: string;
    editedValue: string;
    loadError: null | string;
    loading: boolean;
    value: null | string;
    writeError: null | string;
}

type ValueAction =
    | { error: string; type: "loadFailed" | "writeFailed" }
    | { metadata: unknown; type: "loaded"; value: null | string }
    | { type: "deleteStart" | "saveOk" | "saveStart" }
    | { type: "editMetadata" | "editTtl" | "editValue"; value: string };

const INITIAL_VALUE_STATE: ValueState = {
    busy: "",
    editedMetadata: "",
    editedTtl: "",
    editedValue: "",
    loadError: null,
    loading: true,
    value: null,
    writeError: null,
};

const valueReducer = (state: ValueState, action: ValueAction): ValueState => {
    switch (action.type) {
        case "deleteStart": {
            return { ...state, busy: "deleting", writeError: null };
        }
        case "editMetadata": {
            return { ...state, editedMetadata: action.value };
        }
        case "editTtl": {
            return { ...state, editedTtl: action.value };
        }
        case "editValue": {
            return { ...state, editedValue: action.value };
        }
        case "loaded": {
            return {
                ...state,
                editedMetadata: action.metadata === null || action.metadata === undefined ? "" : JSON.stringify(action.metadata, null, 2),
                editedValue: action.value ?? "",
                loading: false,
                value: action.value,
            };
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
 * metadata on mount; saves the edited value (with editable TTL + metadata) or
 * deletes the key.
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
        dispatch({ type: "editValue", value: event.target.value });
    };

    const onEditedMetadataChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
        dispatch({ type: "editMetadata", value: event.target.value });
    };

    const onEditedTtlChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        dispatch({ type: "editTtl", value: event.target.value });
    };

    const formattedValue = tryFormatJson(state.editedValue);
    const metadataValid = isJsonOrEmpty(state.editedMetadata);

    const onFormatValue = (): void => {
        if (formattedValue !== null) {
            dispatch({ type: "editValue", value: formattedValue });
        }
    };

    const onSave = (): void => {
        if (!metadataValid) {
            dispatch({ error: t("Metadata must be valid JSON."), type: "writeFailed" });

            return;
        }

        dispatch({ type: "saveStart" });

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    // Re-send metadata + a TTL/expiration so the save preserves them — a
                    // bare value PUT would clear metadata and drop the TTL (KV `put`
                    // replaces the whole entry). A fresh TTL wins; otherwise the key's
                    // existing absolute expiration is re-sent to keep it.
                    const ttl = parseTtl(state.editedTtl);
                    const metadata = state.editedMetadata.trim() === "" ? undefined : (JSON.parse(state.editedMetadata) as unknown);

                    await client.putKvValue({
                        expiration: ttl === undefined ? expiration : undefined,
                        expirationTtl: ttl,
                        key: keyName,
                        metadata,
                        namespace,
                        value: state.editedValue,
                    });
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
            <div className="mb-2 flex items-center gap-2">
                <p className="flex-1 truncate font-mono text-xs text-muted-foreground" data-testid="kv-selected-key">
                    {keyName}
                </p>
                <Button
                    data-testid="kv-copy-key-btn"
                    onClick={() => {
                        copyToClipboard(keyName);
                    }}
                    size="sm"
                    variant="outline"
                >
                    {t("Copy key")}
                </Button>
            </div>

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
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Label className="text-xs" htmlFor="kv-value-editor">
                            {t("Value")}
                        </Label>
                        {formattedValue !== null && <Badge variant="secondary">{t("JSON")}</Badge>}
                        <span className="ml-auto text-xs tabular-nums text-muted-foreground" data-testid="kv-value-size">
                            {formatBytes(byteLength(state.editedValue))}
                        </span>
                    </div>

                    <textarea
                        aria-label={t("KV value")}
                        className="mb-2 min-h-[8rem] w-full rounded border border-border bg-muted/30 p-2 font-mono text-xs"
                        data-testid="kv-value-editor"
                        id="kv-value-editor"
                        onChange={onEditedValueChange}
                        value={state.editedValue}
                    />

                    <div className="mb-3 flex flex-wrap gap-2">
                        <Button data-testid="kv-format-btn" disabled={formattedValue === null} onClick={onFormatValue} size="sm" variant="outline">
                            {t("Format JSON")}
                        </Button>
                        <Button
                            data-testid="kv-copy-value-btn"
                            onClick={() => {
                                copyToClipboard(state.editedValue);
                            }}
                            size="sm"
                            variant="outline"
                        >
                            {t("Copy value")}
                        </Button>
                    </div>

                    <div className="mb-3 grid gap-1">
                        <Label className="text-xs" htmlFor="kv-ttl-input">
                            {t("TTL (seconds)")}
                        </Label>
                        <Input
                            data-testid="kv-ttl-input"
                            id="kv-ttl-input"
                            inputMode="numeric"
                            onChange={onEditedTtlChange}
                            placeholder={expiration === undefined ? t("No expiration") : formatExpiration(expiration)}
                            value={state.editedTtl}
                        />
                        <p className="text-xs text-muted-foreground">{t("Leave blank to keep the current expiration.")}</p>
                    </div>

                    <div className="mb-3 grid gap-1">
                        <Label className="text-xs" htmlFor="kv-metadata-editor">
                            {t("Metadata (JSON)")}
                        </Label>
                        <Textarea
                            aria-invalid={!metadataValid}
                            className="min-h-[4rem] font-mono text-xs"
                            data-testid="kv-metadata-editor"
                            id="kv-metadata-editor"
                            onChange={onEditedMetadataChange}
                            value={state.editedMetadata}
                        />
                        {!metadataValid && (
                            <p className="text-xs text-destructive" data-testid="kv-metadata-invalid">
                                {t("Metadata must be valid JSON.")}
                            </p>
                        )}
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <Button data-testid="kv-save-btn" disabled={state.busy !== "" || !metadataValid} onClick={onSave}>
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

// --- create form: a self-contained, collapsible "new key" form. Owns its own
// field state; on success it calls `onCreated` so the list reloads. ---

const KvCreateForm = ({
    namespace,
    onCancel,
    onCreated,
}: {
    readonly namespace: string;
    readonly onCancel: () => void;
    readonly onCreated: () => void;
}): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [name, setName] = useState("");
    const [value, setValue] = useState("");
    const [ttl, setTtl] = useState("");
    const [metadata, setMetadata] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<null | string>(null);

    const metadataValid = isJsonOrEmpty(metadata);
    const canSubmit = name.trim() !== "" && metadataValid && !busy;

    const onSubmit = (): void => {
        if (!canSubmit) {
            return;
        }

        setBusy(true);
        setError(null);

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const parsedTtl = parseTtl(ttl);

                    await client.putKvValue({
                        expirationTtl: parsedTtl,
                        key: name,
                        metadata: metadata.trim() === "" ? undefined : (JSON.parse(metadata) as unknown),
                        namespace,
                        value,
                    });
                    onCreated();
                } catch (error_) {
                    setBusy(false);
                    setError(errorMessage(error_));
                }
            })(),
        );
    };

    return (
        <section className="border border-border bg-card p-3" data-testid="kv-create-form">
            <div className="grid gap-3">
                <div className="grid gap-1">
                    <Label className="text-xs" htmlFor="kv-create-name">
                        {t("Key name")}
                    </Label>
                    <Input
                        autoFocus
                        data-testid="kv-create-name"
                        id="kv-create-name"
                        onChange={(event) => {
                            setName(event.target.value);
                        }}
                        placeholder={t("Key name")}
                        value={name}
                    />
                </div>

                <div className="grid gap-1">
                    <Label className="text-xs" htmlFor="kv-create-value">
                        {t("Value")}
                    </Label>
                    <Textarea
                        className="min-h-[6rem] font-mono text-xs"
                        data-testid="kv-create-value"
                        id="kv-create-value"
                        onChange={(event) => {
                            setValue(event.target.value);
                        }}
                        value={value}
                    />
                </div>

                <div className="grid gap-1">
                    <Label className="text-xs" htmlFor="kv-create-ttl">
                        {t("TTL (seconds)")}
                    </Label>
                    <Input
                        data-testid="kv-create-ttl"
                        id="kv-create-ttl"
                        inputMode="numeric"
                        onChange={(event) => {
                            setTtl(event.target.value);
                        }}
                        placeholder={t("No expiration")}
                        value={ttl}
                    />
                </div>

                <div className="grid gap-1">
                    <Label className="text-xs" htmlFor="kv-create-metadata">
                        {t("Metadata (JSON)")}
                    </Label>
                    <Textarea
                        aria-invalid={!metadataValid}
                        className="min-h-[4rem] font-mono text-xs"
                        data-testid="kv-create-metadata"
                        id="kv-create-metadata"
                        onChange={(event) => {
                            setMetadata(event.target.value);
                        }}
                        value={metadata}
                    />
                    {!metadataValid && (
                        <p className="text-xs text-destructive" data-testid="kv-create-metadata-invalid">
                            {t("Metadata must be valid JSON.")}
                        </p>
                    )}
                </div>

                <div className="flex flex-wrap gap-2">
                    <Button data-testid="kv-create-submit" disabled={!canSubmit} onClick={onSubmit}>
                        {busy ? t("Creating…") : t("Create key")}
                    </Button>
                    <Button data-testid="kv-create-cancel" disabled={busy} onClick={onCancel} variant="outline">
                        {t("Cancel")}
                    </Button>
                </div>

                {error !== null && (
                    <p className="text-sm text-destructive" data-testid="kv-create-error" role="alert">
                        {error}
                    </p>
                )}
            </div>
        </section>
    );
};

// --- key list: one reducer for the paginated, prefix-filtered listing. The
// `appliedPrefix` lives here (not a bare useState) because it drives the load
// effect; the prefix input is a separate, display-only field. `reloadNonce`
// forces a first-page refetch after a create or bulk delete. ---

interface KeyListState {
    appliedPrefix: string;
    bulk: string[];
    bulkBusy: boolean;
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
    | { error: string; type: "loadFailed" }
    | { name: string; type: "keyDeleted" | "toggleBulk" }
    | { name: null | string; type: "selectKey" }
    | { names: string[]; type: "bulkDeleted" | "toggleAllBulk" }
    | { type: "applyFilter" | "bulkDeleteStart" | "clearBulk" | "loadStart" | "reload" }
    | { type: "prefixInput"; value: string };

const INITIAL_KEY_LIST_STATE: KeyListState = {
    appliedPrefix: "",
    bulk: [],
    bulkBusy: false,
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
            return { ...state, appliedPrefix: state.prefixInput, bulk: [], selectedKey: null };
        }
        case "bulkDeleted": {
            const removed = new Set(action.names);

            return {
                ...state,
                bulk: [],
                bulkBusy: false,
                keys: state.keys === null ? null : state.keys.filter((entry) => !removed.has(entry.name)),
                selectedKey: state.selectedKey !== null && removed.has(state.selectedKey) ? null : state.selectedKey,
            };
        }
        case "bulkDeleteStart": {
            return { ...state, bulkBusy: true };
        }
        case "clearBulk": {
            return { ...state, bulk: [] };
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
            return { ...state, bulk: [], reloadNonce: state.reloadNonce + 1, selectedKey: null };
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
    const { appliedPrefix, bulk, bulkBusy, cursor, keys, listComplete, loadError, loading, prefixInput, reloadNonce, selectedKey } = state;
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
                await Promise.all(names.map((name) => client.deleteKvKey({ key: name, namespace })));
                dispatch({ names, type: "bulkDeleted" });
            })(),
            () => {
                dispatch({ names, type: "bulkDeleted" });
            },
        );
    };

    const onCreated = (): void => {
        setShowCreate(false);
        dispatch({ type: "reload" });
    };

    const allSelected = keys !== null && keys.length > 0 && bulk.length === keys.length;

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
                                                    checked={bulk.includes(entry.name)}
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

            {showCreate && (
                <KvCreateForm
                    namespace={namespace}
                    onCancel={() => {
                        setShowCreate(false);
                    }}
                    onCreated={onCreated}
                />
            )}

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
