import type { AuthUserFieldSpec } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ChangeEvent, ReactElement } from "react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { ModalShell } from "../../components/ui/modal-shell";
import { useAsyncSubmit } from "../../hooks/use-async-submit";
import { useAuthConfig } from "../../hooks/use-auth-config";
import { useT } from "../../i18n/i18n-context";

interface UserCreateDialogProps {
    /** Dismiss the dialog without creating. */
    readonly onClose: () => void;
    /** Called after a user is created, so the list can refetch. */
    readonly onCreated: () => void;
}

/** The `<input type>` for a plugin field's value control (booleans get a checkbox instead). */
const INPUT_TYPE_BY_FIELD: Record<AuthUserFieldSpec["type"], string> = {
    boolean: "checkbox",
    date: "datetime-local",
    number: "number",
    string: "text",
};

/** Whether a required field of this spec is satisfied by the current value (a boolean is always satisfied — `false` is a value). */
const isFieldFilled = (field: AuthUserFieldSpec, value: boolean | string): boolean => {
    if (field.type === "boolean") {
        return true;
    }

    if (typeof value !== "string" || value.trim() === "") {
        return false;
    }

    // A required numeric field isn't satisfied by unparseable text: `coerceFieldValue`
    // drops a `NaN`, so the gate must reject it too — otherwise submit enables but the
    // value never reaches the `data` bag, surfacing as a backend "missing field" error.
    return field.type !== "number" || !Number.isNaN(Number(value.trim()));
};

/**
 * Coerce one plugin field's raw control value to its typed `data`-bag value, or
 * `undefined` to omit it. Booleans are sent only when checked (or always, when
 * required); text/number/date are sent only when non-empty (numbers must parse).
 */
const coerceFieldValue = (field: AuthUserFieldSpec, raw: boolean | string): { value: unknown } | undefined => {
    if (field.type === "boolean") {
        if (raw === true) {
            return { value: true };
        }

        return field.required ? { value: false } : undefined;
    }

    const text = typeof raw === "string" ? raw.trim() : "";

    if (text === "") {
        return undefined;
    }

    if (field.type === "number") {
        const numeric = Number(text);

        return Number.isNaN(numeric) ? undefined : { value: numeric };
    }

    // string + date: send the raw text (a `datetime-local` value is an ISO-ish
    // string the auth store coerces on write).
    return { value: text };
};

/**
 * Modal form for creating an auth user via the admin plane
 * (`client.createAuthUser`). Email + name are required (better-auth requires
 * both); password is optional (omit it for a passwordless / OAuth-only user);
 * role is optional and falls back to the auth config's `defaultRole`.
 *
 * Beyond those core columns, the form renders one control per **plugin-derived**
 * user field reported by `getAuthConfig().userFields` — e.g. `username` /
 * `displayUsername` (username plugin), `phoneNumber` (phone-number plugin), or
 * any `user.additionalFields` the app declared. Each is typed (checkbox for
 * booleans, `number` / `datetime-local` / text inputs otherwise) and marked
 * required or optional per its spec, and the filled values are submitted as the
 * `data` bag so the correct columns are populated for whatever plugins the
 * deployment enabled.
 */
export const UserCreateDialog = ({ onClose, onCreated }: UserCreateDialogProps): ReactElement => {
    const client = useLunora();
    const t = useT();
    const { config } = useAuthConfig();
    const { busy, error, run } = useAsyncSubmit();

    const [email, setEmail] = useState<string>("");
    const [name, setName] = useState<string>("");
    const [password, setPassword] = useState<string>("");
    const [role, setRole] = useState<string>("");
    // Plugin-field values keyed by field name; a missing key means "untouched"
    // (rendered from the spec's empty default), so the map only grows as fields
    // are edited and never needs re-seeding when `config` resolves.
    const [fieldValues, setFieldValues] = useState<Record<string, boolean | string>>({});

    const onEmailChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setEmail(event.target.value);
    };
    const onNameChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setName(event.target.value);
    };
    const onPasswordChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setPassword(event.target.value);
    };
    const onRoleChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setRole(event.target.value);
    };

    const setFieldValue = (fieldName: string, value: boolean | string): void => {
        setFieldValues((previous) => {
            return { ...previous, [fieldName]: value };
        });
    };

    /** The current value of a plugin field, falling back to the spec's empty default. */
    const fieldValue = (field: AuthUserFieldSpec): boolean | string => fieldValues[field.name] ?? (field.type === "boolean" ? false : "");

    // Every required plugin field must be filled before the form can submit
    // (email + name are the always-required core columns).
    const requiredFieldsFilled = config.userFields.every((field) => !field.required || isFieldFilled(field, fieldValue(field)));
    const canSubmit = !busy && email.trim() !== "" && name.trim() !== "" && requiredFieldsFilled;

    /** Assemble the `data` bag from the touched/required plugin fields, coercing to each field's type. */
    const buildData = (): Record<string, unknown> | undefined => {
        const data: Record<string, unknown> = {};

        for (const field of config.userFields) {
            const coerced = coerceFieldValue(field, fieldValue(field));

            if (coerced !== undefined) {
                data[field.name] = coerced.value;
            }
        }

        return Object.keys(data).length === 0 ? undefined : data;
    };

    const onSubmit = (): void => {
        run(async () => {
            await client.createAuthUser({
                data: buildData(),
                email: email.trim(),
                name: name.trim(),
                password: password === "" ? undefined : password,
                role: role.trim() === "" ? undefined : role.trim(),
            });
            onCreated();
            onClose();
        });
    };

    return (
        <ModalShell label={t("Create user")} onClose={onClose} panelTestId="uc-dialog" testId="uc-overlay" variant="dialog">
            <h2 className="text-sm font-semibold text-foreground">{t("Create user")}</h2>

            <div className="flex flex-col gap-1">
                <Label htmlFor="uc-email">{t("email")}</Label>
                <Input data-testid="uc-email" id="uc-email" onChange={onEmailChange} type="email" value={email} />
            </div>

            <div className="flex flex-col gap-1">
                <Label htmlFor="uc-name">{t("name")}</Label>
                <Input data-testid="uc-name" id="uc-name" onChange={onNameChange} value={name} />
            </div>

            <div className="flex flex-col gap-1">
                <Label htmlFor="uc-password">{t("Password (optional)")}</Label>
                <Input data-testid="uc-password" id="uc-password" onChange={onPasswordChange} type="password" value={password} />
            </div>

            <div className="flex flex-col gap-1">
                <Label htmlFor="uc-role">{t("Role (optional)")}</Label>
                <Input data-testid="uc-role" id="uc-role" onChange={onRoleChange} value={role} />
            </div>

            {config.userFields.length > 0 && (
                <div className="flex flex-col gap-3 border-t border-border pt-3" data-testid="uc-plugin-fields">
                    <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Plugin fields")}</span>

                    {config.userFields.map((field) => {
                        const inputId = `uc-field-${field.name}`;
                        const suffix = field.required ? "" : ` (${t("optional")})`;

                        if (field.type === "boolean") {
                            const checked = fieldValue(field) === true;

                            return (
                                <label className="flex items-center gap-2" htmlFor={inputId} key={field.name}>
                                    <Checkbox
                                        checked={checked}
                                        data-testid={inputId}
                                        id={inputId}
                                        onCheckedChange={(next: boolean): void => {
                                            setFieldValue(field.name, next);
                                        }}
                                    />
                                    <span className="text-sm">
                                        {field.name}
                                        {suffix}
                                    </span>
                                </label>
                            );
                        }

                        const value = fieldValue(field);

                        return (
                            <div className="flex flex-col gap-1" key={field.name}>
                                <Label htmlFor={inputId}>
                                    {field.name}
                                    {suffix}
                                </Label>
                                <Input
                                    data-testid={inputId}
                                    id={inputId}
                                    onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                                        setFieldValue(field.name, event.target.value);
                                    }}
                                    type={INPUT_TYPE_BY_FIELD[field.type]}
                                    value={typeof value === "string" ? value : ""}
                                />
                            </div>
                        );
                    })}
                </div>
            )}

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="uc-error" role="alert">
                    {error}
                </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
                <Button data-testid="uc-cancel" onClick={onClose} size="sm" type="button" variant="outline">
                    {t("Cancel")}
                </Button>
                <Button data-testid="uc-submit" disabled={!canSubmit} onClick={onSubmit} size="sm" type="button">
                    {busy ? t("Creating…") : t("Create")}
                </Button>
            </div>
        </ModalShell>
    );
};

export type { UserCreateDialogProps };
