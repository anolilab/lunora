import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useReducer } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget } from "../../lib/internal";
import { buildKvPutOptions, isJsonOrEmpty, isTtlValid } from "./kv-fields";
import { MetadataField, TtlField } from "./kv-form-fields";

// --- one reducer for the whole form so a submit (busy + cleared error) is a
// single transition, and the field group stays cohesive. ---

interface CreateState {
    busy: boolean;
    error: null | string;
    metadata: string;
    name: string;
    ttl: string;
    value: string;
}

type CreateAction =
    { error: string; type: "submitFailed" } | { field: "metadata" | "name" | "ttl" | "value"; type: "setField"; value: string } | { type: "submitStart" };

const INITIAL_CREATE_STATE: CreateState = { busy: false, error: null, metadata: "", name: "", ttl: "", value: "" };

const createReducer = (state: CreateState, action: CreateAction): CreateState => {
    switch (action.type) {
        case "setField": {
            return { ...state, [action.field]: action.value };
        }
        case "submitFailed": {
            return { ...state, busy: false, error: action.error };
        }
        case "submitStart": {
            return { ...state, busy: true, error: null };
        }
        default: {
            return state;
        }
    }
};

/**
 * Renders the new-key form inside the side sheet. Owns its own field state; on
 * success it calls `onCreated` so the parent list reloads. Shares the value/TTL/
 * metadata fields + the `putKvValue` payload contract with the value editor.
 */
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

    const [state, dispatch] = useReducer(createReducer, INITIAL_CREATE_STATE);

    const metadataValid = isJsonOrEmpty(state.metadata);
    const ttlValid = isTtlValid(state.ttl);
    const canSubmit = state.name.trim() !== "" && metadataValid && ttlValid && !state.busy;

    const onSubmit = (): void => {
        if (!canSubmit) {
            return;
        }

        dispatch({ type: "submitStart" });

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    await client.putKvValue(buildKvPutOptions({ metadata: state.metadata, ttl: state.ttl, value: state.value }, state.name, namespace));
                    onCreated();
                } catch (error_) {
                    dispatch({ error: errorMessage(error_), type: "submitFailed" });
                }
            })(),
        );
    };

    return (
        <div className="grid gap-3 px-4 pb-4" data-testid="kv-create-form">
            <div className="grid gap-1">
                <Label className="text-xs" htmlFor="kv-create-name">
                    {t("Key name")}
                </Label>
                <Input
                    autoFocus
                    data-testid="kv-create-name"
                    id="kv-create-name"
                    onChange={(event) => {
                        dispatch({ field: "name", type: "setField", value: event.target.value });
                    }}
                    placeholder={t("Key name")}
                    value={state.name}
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
                        dispatch({ field: "value", type: "setField", value: event.target.value });
                    }}
                    value={state.value}
                />
            </div>

            <TtlField
                id="kv-create-ttl"
                invalid={!ttlValid}
                onChange={(seconds) => {
                    dispatch({ field: "ttl", type: "setField", value: seconds });
                }}
                testId="kv-create-ttl"
            />

            <MetadataField
                id="kv-create-metadata"
                invalidTestId="kv-create-metadata-invalid"
                onChange={(metadata) => {
                    dispatch({ field: "metadata", type: "setField", value: metadata });
                }}
                testId="kv-create-metadata"
                valid={metadataValid}
                value={state.metadata}
            />

            <div className="flex flex-wrap gap-2">
                <Button data-testid="kv-create-submit" disabled={!canSubmit} onClick={onSubmit}>
                    {state.busy ? t("Creating…") : t("Create key")}
                </Button>
                <Button data-testid="kv-create-cancel" disabled={state.busy} onClick={onCancel} variant="outline">
                    {t("Cancel")}
                </Button>
            </div>

            {state.error !== null && (
                <p className="text-sm text-destructive" data-testid="kv-create-error" role="alert">
                    {state.error}
                </p>
            )}
        </div>
    );
};
export default KvCreateForm;
