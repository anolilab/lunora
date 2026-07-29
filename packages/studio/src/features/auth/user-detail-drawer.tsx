import type { AuthCapabilities, AuthUser } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ChangeEvent, ReactElement } from "react";
import { useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { ModalShell } from "../../components/ui/modal-shell";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget, formatCell, formatTimestamp } from "../../lib/internal";
import { UserAccountsPanel, UserSecurityPanel, UserSessionsPanel } from "./user-related-panels";

interface UserDetailDrawerProps {
    /** Which dashboard surfaces the auth config supports — gates the related panels. */
    readonly capabilities: AuthCapabilities;
    /** Called after any mutation so the parent list can refetch. */
    readonly onChanged: () => void;
    /** Close the drawer. */
    readonly onClose: () => void;
    /** The user being inspected. */
    readonly user: AuthUser;
}

const TIMESTAMP_RE = /(?:at|expires)$/iu;

/** Fields shown as dedicated summary chips / forms, so the raw field list skips them. */
const SUMMARY_FIELDS = new Set(["banExpires", "banned", "banReason", "email", "emailVerified", "id", "name", "role"]);

/** Format one raw field value for display, rendering epoch-ms timestamps readably. */
const formatField = (key: string, value: unknown): string => {
    if (typeof value === "number" && TIMESTAMP_RE.test(key)) {
        return formatTimestamp(value);
    }

    return formatCell(value);
};

/**
 * Right-side drawer for a single auth user: identity summary, every raw field
 * (including app `additionalFields`), the admin actions the dashboard exposes
 * (set role, ban / unban, set password, impersonate, revoke-all, delete), and —
 * gated on {@link AuthCapabilities} — the related-data panels (sessions, linked
 * accounts, security factors). All mutations run through one shared `runAction`
 * that surfaces a single busy/error model and bumps a `version` so the related
 * panels refetch on success and the parent list is notified via `onChanged`.
 */
export const UserDetailDrawer = ({ capabilities, onChanged, onClose, user }: UserDetailDrawerProps): ReactElement => {
    const client = useLunora();
    const t = useT();

    const banned = user.banned === true;

    const [actionError, setActionError] = useState<null | string>(null);
    const [busy, setBusy] = useState<boolean>(false);
    const [version, setVersion] = useState<number>(0);

    const [roleInput, setRoleInput] = useState<string>(typeof user.role === "string" ? user.role : "");
    const [banReason, setBanReason] = useState<string>("");
    const [banDays, setBanDays] = useState<string>("");
    const [newPassword, setNewPassword] = useState<string>("");
    const [impersonationToken, setImpersonationToken] = useState<null | string>(null);
    const [confirmDelete, setConfirmDelete] = useState<boolean>(false);

    /**
     * Run a mutation under one busy/error model. On success it bumps `version`
     * (so the related panels refetch) and notifies the list via `onChanged` —
     * unless `refresh: false` (for read-only actions like impersonate that don't
     * change the list). `onResult` receives the action's return value.
     */
    const runAction = <T,>(action: () => Promise<T>, options?: { onResult?: (result: T) => void; refresh?: boolean }): void => {
        fireAndForget(
            (async (): Promise<void> => {
                setBusy(true);
                setActionError(null);

                try {
                    const result = await action();

                    if (options?.refresh !== false) {
                        setVersion((value) => value + 1);
                        onChanged();
                    }

                    options?.onResult?.(result);
                } catch (error_) {
                    setActionError(errorMessage(error_));
                }

                setBusy(false);
            })(),
        );
    };

    const onRoleInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setRoleInput(event.target.value);
    };
    const onBanReasonChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setBanReason(event.target.value);
    };
    const onBanDaysChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setBanDays(event.target.value);
    };
    const onNewPasswordChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setNewPassword(event.target.value);
    };

    const onSetRole = (): void => {
        const role = roleInput.trim();

        if (role === "") {
            return;
        }

        runAction(async () => {
            await client.setAuthUserRole({ role, userId: user.id });
        });
    };

    const onBan = (): void => {
        const days = Number.parseInt(banDays, 10);
        const expiresInSeconds = Number.isFinite(days) && days > 0 ? days * 86_400 : undefined;

        runAction(async () => {
            await client.banAuthUser({ expiresInSeconds, reason: banReason.trim() === "" ? undefined : banReason.trim(), userId: user.id });
        });
    };

    const onUnban = (): void => {
        runAction(async () => {
            await client.unbanAuthUser({ userId: user.id });
        });
    };

    const onSetPassword = (): void => {
        // react-doctor-disable-next-line react-doctor/no-impure-state-updater -- `runAction` is this drawer's async-action helper, not a state updater — the callback is an async thunk, and React never re-runs it
        runAction(async () => {
            await client.setAuthUserPassword({ newPassword, userId: user.id });
            setNewPassword("");
        });
    };

    const onImpersonate = (): void => {
        // `refresh: false` — impersonation mints a token but doesn't change the list.
        runAction(() => client.impersonateAuthUser({ userId: user.id }), {
            onResult: (result) => {
                setImpersonationToken(result.token);
            },
            refresh: false,
        });
    };

    const onRevokeAll = (): void => {
        runAction(async () => {
            await client.revokeAuthUserSessions({ userId: user.id });
        });
    };

    const onDelete = (): void => {
        runAction(async () => {
            await client.removeAuthUser({ userId: user.id });
            onClose();
        });
    };

    const onConfirmDelete = (): void => {
        setConfirmDelete(true);
    };
    const onCancelDelete = (): void => {
        setConfirmDelete(false);
    };

    const rawFields = Object.entries(user).filter(([key]) => !SUMMARY_FIELDS.has(key));

    return (
        <ModalShell label={t("User details")} onClose={onClose} panelTestId="ud-panel" testId="ud-overlay" variant="drawer">
            <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-semibold text-foreground">{user.name ?? user.email ?? user.id}</h2>
                    <p className="font-mono text-xs text-muted-foreground">{user.id}</p>
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        {typeof user.role === "string" && user.role !== "" && <Badge variant="secondary">{user.role}</Badge>}
                        {banned ? <Badge variant="destructive">{t("Banned")}</Badge> : <Badge variant="outline">{t("Active")}</Badge>}
                        {user.emailVerified === true ? <Badge variant="secondary">{t("verified")}</Badge> : <Badge variant="outline">{t("unverified")}</Badge>}
                    </div>
                </div>
                <Button data-testid="ud-close" onClick={onClose} size="sm" type="button" variant="ghost">
                    {t("Close")}
                </Button>
            </div>

            {actionError !== null && (
                <p className="text-sm text-destructive" data-testid="ud-action-error" role="alert">
                    {actionError}
                </p>
            )}

            {/* --- Actions (admin() plugin) — gated so a deployment without it doesn't show ops that 404 --- */}
            {capabilities.admin && (
                <Card className="gap-0 py-0">
                    <header className="border-b border-border px-4 py-3">
                        <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Actions")}</span>
                    </header>
                    <CardContent className="flex flex-col gap-3 p-3">
                        <div className="flex items-end gap-2">
                            <div className="flex flex-1 flex-col gap-1">
                                <Label htmlFor="ud-role">{t("Role")}</Label>
                                <Input data-testid="ud-role-input" id="ud-role" onChange={onRoleInputChange} value={roleInput} />
                            </div>
                            <Button
                                data-testid="ud-set-role"
                                disabled={busy || roleInput.trim() === ""}
                                onClick={onSetRole}
                                size="sm"
                                type="button"
                                variant="outline"
                            >
                                {t("Set role")}
                            </Button>
                        </div>

                        {banned ? (
                            <Button data-testid="ud-unban" disabled={busy} onClick={onUnban} size="sm" type="button" variant="outline">
                                {t("Unban")}
                            </Button>
                        ) : (
                            <div className="flex items-end gap-2">
                                <div className="flex flex-1 flex-col gap-1">
                                    <Label htmlFor="ud-ban-reason">{t("Ban reason (optional)")}</Label>
                                    <Input data-testid="ud-ban-reason" id="ud-ban-reason" onChange={onBanReasonChange} value={banReason} />
                                </div>
                                <div className="flex w-24 flex-col gap-1">
                                    <Label htmlFor="ud-ban-days">{t("Days")}</Label>
                                    <Input data-testid="ud-ban-days" id="ud-ban-days" onChange={onBanDaysChange} type="number" value={banDays} />
                                </div>
                                <Button data-testid="ud-ban" disabled={busy} onClick={onBan} size="sm" type="button" variant="destructive">
                                    {t("Ban user")}
                                </Button>
                            </div>
                        )}

                        <div className="flex items-end gap-2">
                            <div className="flex flex-1 flex-col gap-1">
                                <Label htmlFor="ud-password">{t("New password")}</Label>
                                <Input data-testid="ud-password" id="ud-password" onChange={onNewPasswordChange} type="password" value={newPassword} />
                            </div>
                            <Button
                                data-testid="ud-set-password"
                                disabled={busy || newPassword === ""}
                                onClick={onSetPassword}
                                size="sm"
                                type="button"
                                variant="outline"
                            >
                                {t("Set password")}
                            </Button>
                        </div>

                        <div className="flex flex-wrap gap-2">
                            <Button data-testid="ud-impersonate" disabled={busy} onClick={onImpersonate} size="sm" type="button" variant="outline">
                                {t("Impersonate")}
                            </Button>
                            <Button data-testid="ud-revoke-all" disabled={busy} onClick={onRevokeAll} size="sm" type="button" variant="outline">
                                {t("Revoke all sessions")}
                            </Button>
                            {confirmDelete ? (
                                <>
                                    <Button data-testid="ud-delete-confirm" disabled={busy} onClick={onDelete} size="sm" type="button" variant="destructive">
                                        {t("Confirm delete")}
                                    </Button>
                                    <Button data-testid="ud-delete-cancel" onClick={onCancelDelete} size="sm" type="button" variant="ghost">
                                        {t("Cancel")}
                                    </Button>
                                </>
                            ) : (
                                <Button data-testid="ud-delete" disabled={busy} onClick={onConfirmDelete} size="sm" type="button" variant="destructive">
                                    {t("Delete user")}
                                </Button>
                            )}
                        </div>

                        {impersonationToken !== null && (
                            <div className="flex flex-col gap-1" data-testid="ud-impersonation">
                                <Label htmlFor="ud-token">{t("Impersonation token")}</Label>
                                <Input data-testid="ud-token" id="ud-token" readOnly value={impersonationToken} />
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}

            {/* --- Related data (capability-gated) ----------------------------- */}
            <UserSessionsPanel busy={busy} runAction={runAction} userId={user.id} version={version} />
            {capabilities.accounts && <UserAccountsPanel busy={busy} runAction={runAction} userId={user.id} version={version} />}
            {(capabilities.twoFactor || capabilities.passkey) && (
                <UserSecurityPanel busy={busy} capabilities={capabilities} runAction={runAction} userId={user.id} version={version} />
            )}

            {/* --- Raw fields -------------------------------------------------- */}
            <div className="flex flex-col gap-1" data-testid="ud-fields">
                <h3 className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{t("Fields")}</h3>
                <dl className="flex flex-col">
                    {rawFields.map(([key, value]) => (
                        <div className="flex flex-col border-t border-border py-1.5" key={key}>
                            <dt className="text-xs font-semibold text-muted-foreground">{key}</dt>
                            <dd className="m-0 font-mono text-xs break-words">{formatField(key, value)}</dd>
                        </div>
                    ))}
                </dl>
            </div>
        </ModalShell>
    );
};

export type { UserDetailDrawerProps };
