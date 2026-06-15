import { useLunora } from "@lunora/react";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { ModalShell } from "../../components/ui/modal-shell";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget } from "../../lib/internal";

interface UserCreateDialogProps {
    /** Dismiss the dialog without creating. */
    readonly onClose: () => void;
    /** Called after a user is created, so the list can refetch. */
    readonly onCreated: () => void;
}

/**
 * Modal form for creating an auth user via the admin plane
 * (`client.createAuthUser`). Email + name are required (better-auth requires
 * both); password is optional (omit it for a passwordless / OAuth-only user);
 * role is optional and falls back to the auth config's `defaultRole`.
 */
export const UserCreateDialog = ({ onClose, onCreated }: UserCreateDialogProps): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [email, setEmail] = useState<string>("");
    const [name, setName] = useState<string>("");
    const [password, setPassword] = useState<string>("");
    const [role, setRole] = useState<string>("");
    const [busy, setBusy] = useState<boolean>(false);
    const [error, setError] = useState<null | string>(null);

    const onEmailChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setEmail(event.target.value);
    }, []);
    const onNameChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setName(event.target.value);
    }, []);
    const onPasswordChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setPassword(event.target.value);
    }, []);
    const onRoleChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setRole(event.target.value);
    }, []);

    const submit = useCallback(async (): Promise<void> => {
        setBusy(true);
        setError(null);

        try {
            await client.createAuthUser({
                email: email.trim(),
                name: name.trim(),
                password: password === "" ? undefined : password,
                role: role.trim() === "" ? undefined : role.trim(),
            });
            onCreated();
            onClose();
        } catch (error_) {
            setError(errorMessage(error_));
        } finally {
            setBusy(false);
        }
    }, [client, email, name, password, role, onClose, onCreated]);

    const onSubmit = useCallback((): void => {
        fireAndForget(submit());
    }, [submit]);

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

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="uc-error" role="alert">
                    {error}
                </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
                <Button data-testid="uc-cancel" onClick={onClose} size="sm" type="button" variant="outline">
                    {t("Cancel")}
                </Button>
                <Button data-testid="uc-submit" disabled={busy || email.trim() === "" || name.trim() === ""} onClick={onSubmit} size="sm" type="button">
                    {busy ? t("Creating…") : t("Create")}
                </Button>
            </div>
        </ModalShell>
    );
};

export type { UserCreateDialogProps };
