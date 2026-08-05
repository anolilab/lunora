import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useReducer } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { useT } from "../../i18n/i18n-context";
import { copyToClipboard, errorMessage, fireAndForget, formatBytes } from "../../lib/internal";
import { buildKvPutOptions, byteLength, isJsonOrEmpty, isTtlValid, tryFormatJson } from "./kv-fields";
import { MetadataField, TtlField } from "./kv-form-fields";

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

    const onEditedMetadataChange = (metadata: string): void => {
        dispatch({ type: "editMetadata", value: metadata });
    };

    const formattedValue = tryFormatJson(state.editedValue);
    const metadataValid = isJsonOrEmpty(state.editedMetadata);
    const ttlValid = isTtlValid(state.editedTtl);

    const onFormatValue = (): void => {
        if (formattedValue !== undefined) {
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
                    // The KV-write contract (fresh TTL wins, else re-send the key's
                    // existing expiration so the edit doesn't drop it; empty metadata →
                    // undefined) lives in `buildKvPutOptions`, shared with the create form.
                    await client.putKvValue(
                        buildKvPutOptions({ metadata: state.editedMetadata, ttl: state.editedTtl, value: state.editedValue }, keyName, namespace, expiration),
                    );
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
        <div className="px-4 pb-4" data-testid="kv-value-section">
            <div className="mb-2 flex justify-end">
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
                        {formattedValue !== undefined && <Badge variant="secondary">{t("JSON")}</Badge>}
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
                        <Button data-testid="kv-format-btn" disabled={formattedValue === undefined} onClick={onFormatValue} size="sm" variant="outline">
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

                    <TtlField
                        helper={t("Leave blank to keep the current expiration.")}
                        id="kv-ttl-input"
                        invalid={!ttlValid}
                        onChange={(seconds) => {
                            dispatch({ type: "editTtl", value: seconds });
                        }}
                        testId="kv-ttl-input"
                    />

                    <MetadataField
                        id="kv-metadata-editor"
                        invalidTestId="kv-metadata-invalid"
                        onChange={onEditedMetadataChange}
                        testId="kv-metadata-editor"
                        valid={metadataValid}
                        value={state.editedMetadata}
                    />

                    <div className="flex flex-wrap gap-2">
                        <Button data-testid="kv-save-btn" disabled={state.busy !== "" || !metadataValid || !ttlValid} onClick={onSave}>
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
        </div>
    );
};
export default KvValueEditor;
