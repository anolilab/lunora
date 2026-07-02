import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget } from "../../lib/internal";
import { buildKvPutOptions, isJsonOrEmpty, isTtlValid } from "./kv-fields";
import { MetadataField, TtlField } from "./kv-form-fields";

/**
 * Renders the new-key form inside the side sheet. Owns its own field state; on
 * success it calls `onCreated` so the parent list reloads. Shares the value/TTL/
 * metadata fields + the `putKvValue` payload contract with the value editor.
 */
export const KvCreateForm = ({
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
    const ttlValid = isTtlValid(ttl);
    const canSubmit = name.trim() !== "" && metadataValid && ttlValid && !busy;

    const onSubmit = (): void => {
        if (!canSubmit) {
            return;
        }

        setBusy(true);
        setError(null);

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    await client.putKvValue(buildKvPutOptions({ metadata, ttl, value }, name, namespace));
                    onCreated();
                } catch (error_) {
                    setBusy(false);
                    setError(errorMessage(error_));
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

            <TtlField
                id="kv-create-ttl"
                invalid={!ttlValid}
                onChange={(seconds) => {
                    setTtl(seconds);
                }}
                testId="kv-create-ttl"
            />

            <MetadataField
                id="kv-create-metadata"
                invalidTestId="kv-create-metadata-invalid"
                onChange={(event) => {
                    setMetadata(event.target.value);
                }}
                testId="kv-create-metadata"
                valid={metadataValid}
                value={metadata}
            />

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
    );
};
