import type { ReactElement } from "react";

import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { useT } from "../../i18n/i18n-context";

/**
 * Shared "TTL (seconds)" field for the value editor and create form. Shows the
 * ≥60s validity error when `invalid`, else the optional helper text. `testId`
 * keys the input; its error surfaces under `${testId}-invalid`.
 */
export const TtlField = ({
    helper,
    id,
    invalid,
    onChange,
    placeholder,
    testId,
    value,
}: {
    readonly helper?: string;
    readonly id: string;
    readonly invalid: boolean;
    readonly onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    readonly placeholder?: string;
    readonly testId: string;
    readonly value: string;
}): ReactElement => {
    const t = useT();

    return (
        <div className="mb-3 grid gap-1">
            <Label className="text-xs" htmlFor={id}>
                {t("TTL (seconds)")}
            </Label>
            <Input aria-invalid={invalid} data-testid={testId} id={id} inputMode="numeric" onChange={onChange} placeholder={placeholder} value={value} />
            {invalid ? (
                <p className="text-xs text-destructive" data-testid={`${testId}-invalid`}>
                    {t("TTL must be a whole number of at least 60 seconds.")}
                </p>
            ) : (
                helper !== undefined && <p className="text-xs text-muted-foreground">{helper}</p>
            )}
        </div>
    );
};

/**
 * Shared "Metadata (JSON)" field for the value editor and create form. Renders
 * the invalid-JSON hint under `invalidTestId` when `valid` is false.
 */
export const MetadataField = ({
    id,
    invalidTestId,
    onChange,
    testId,
    valid,
    value,
}: {
    readonly id: string;
    readonly invalidTestId: string;
    readonly onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
    readonly testId: string;
    readonly valid: boolean;
    readonly value: string;
}): ReactElement => {
    const t = useT();

    return (
        <div className="mb-3 grid gap-1">
            <Label className="text-xs" htmlFor={id}>
                {t("Metadata (JSON)")}
            </Label>
            <Textarea aria-invalid={!valid} className="min-h-[4rem] font-mono text-xs" data-testid={testId} id={id} onChange={onChange} value={value} />
            {!valid && (
                <p className="text-xs text-destructive" data-testid={invalidTestId}>
                    {t("Metadata must be valid JSON.")}
                </p>
            )}
        </div>
    );
};
