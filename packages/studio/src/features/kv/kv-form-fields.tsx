import type { ReactElement } from "react";
import { useState } from "react";

import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { useT } from "../../i18n/i18n-context";
import type { TtlUnit } from "./kv-fields";
import { TTL_UNITS, ttlToSeconds } from "./kv-fields";

/**
 * Shared "Expires after" field for the value editor and create form: an amount
 * input paired with a unit picker (seconds / minutes / hours / days) so users
 * never hand-convert to seconds. It owns the amount + unit and reports the
 * computed **seconds** string via `onChange` (`""` when blank), keeping the
 * seconds-based validation + put-payload contract unchanged. Shows the ≥60s
 * validity error when `invalid`, else the optional helper. `testId` keys the
 * amount input; the unit picker is `${testId}-unit`, the error `${testId}-invalid`.
 */
export const TtlField = ({
    helper,
    id,
    invalid,
    onChange,
    testId,
}: {
    readonly helper?: string;
    readonly id: string;
    readonly invalid: boolean;
    readonly onChange: (seconds: string) => void;
    readonly testId: string;
}): ReactElement => {
    const t = useT();

    const [amount, setAmount] = useState("");
    const [unit, setUnit] = useState<TtlUnit>("seconds");

    const onAmountChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        setAmount(event.target.value);
        onChange(ttlToSeconds(event.target.value, unit));
    };

    const onUnitChange = (nextUnit: null | TtlUnit): void => {
        if (nextUnit === null) {
            return;
        }

        setUnit(nextUnit);
        onChange(ttlToSeconds(amount, nextUnit));
    };

    const unitLabel: Record<TtlUnit, string> = { days: t("days"), hours: t("hours"), minutes: t("minutes"), seconds: t("seconds") };

    return (
        <div className="mb-3 grid gap-1">
            <Label className="text-xs" htmlFor={id}>
                {t("Expires after")}
            </Label>
            <div className="flex gap-2">
                <Input
                    aria-invalid={invalid}
                    className="flex-1"
                    data-testid={testId}
                    id={id}
                    inputMode="numeric"
                    onChange={onAmountChange}
                    placeholder={t("No expiration")}
                    value={amount}
                />
                <Select onValueChange={onUnitChange} value={unit}>
                    <SelectTrigger aria-label={t("TTL unit")} className="w-[7.5rem]" data-testid={`${testId}-unit`}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {TTL_UNITS.map((option) => (
                            <SelectItem key={option.key} value={option.key}>
                                {unitLabel[option.key]}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            {invalid ? (
                <p className="text-xs text-destructive" data-testid={`${testId}-invalid`}>
                    {t("TTL must be at least 60 seconds.")}
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
