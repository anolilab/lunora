"use client";

import type { ReactElement } from "react";
import { useState } from "react";

import { createAdminUsersController } from "../core/admin-users";
import { createBackupCodesController } from "../core/backup-codes";
import { createDeviceAuthorizationController } from "../core/device-authorization";
import { isFlowEnabled } from "../core/flow-gate";
import { ROLE_OPTIONS } from "../core/labels";
import { createDeviceSessionsController } from "../core/multi-session";
import { createTeamsController } from "../core/teams";
import { AuthCard, Field, FormBanner, Skeleton, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";
import { UserView } from "./user-button";

const onSubmit =
    (run: () => void) =>
    (event: { preventDefault: () => void }): void => {
        event.preventDefault();
        run();
    };

/**
 * The accounts signed in on *this device*, with switch and sign-out-just-this.
 *
 * Not `<SessionsCard>`, which lists this account's sessions across every device.
 * The two are a keystroke apart in better-auth's API and mean opposite things.
 */
const MultiSessionCard = (): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const enabled = isFlowEnabled(context, "multiSession", "MultiSessionCard");
    const [state, actions] = useController((context_) => createDeviceSessionsController(context_, { autoLoad: enabled }));

    if (!enabled) {
        return null;
    }

    return (
        <AuthCard title={t.multiSessionTitle}>
            <FormBanner error={state.error} />
            {state.loading ? (
                <Skeleton rows={2} />
            ) : (
                <ul className="lunora-auth-list">
                    {state.items.map((entry) => (
                        <li className="lunora-auth-list__item" key={entry.session?.token ?? entry.user?.id}>
                            <UserView compact user={entry.user} />
                            <span className="lunora-auth-list__actions">
                                <button
                                    className="lunora-auth-button lunora-auth-button--secondary"
                                    disabled={state.busy}
                                    onClick={() => {
                                        void actions.setActive(entry.session?.token ?? "");
                                    }}
                                    type="button"
                                >
                                    {t.switchAccount}
                                </button>
                                <button
                                    className="lunora-auth-button lunora-auth-button--danger"
                                    disabled={state.busy}
                                    onClick={() => {
                                        void actions.revoke(entry.session?.token ?? "");
                                    }}
                                    type="button"
                                >
                                    {t.signOut}
                                </button>
                            </span>
                        </li>
                    ))}
                    {state.items.length === 0 ? <li className="lunora-auth-list__empty">{t.multiSessionEmpty}</li> : null}
                </ul>
            )}
        </AuthCard>
    );
};

/**
 * The admin plugin's user table.
 *
 * Every action here is destructive or privilege-changing, so none of them are
 * optimistic and none are one click from a row's primary target — impersonation
 * in particular navigates away rather than mutating in place, because the whole
 * app is a different user afterwards.
 */
const AdminUsersCard = (): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const enabled = isFlowEnabled(context, "admin", "AdminUsersCard");
    const [state, actions] = useController((context_) => createAdminUsersController(context_, { autoLoad: enabled }));

    if (!enabled) {
        return null;
    }

    return (
        <AuthCard title={t.adminTitle}>
            <FormBanner error={state.error} />
            <input
                aria-label={t.adminSearch}
                className="lunora-auth-field__input"
                onChange={(event) => {
                    void actions.setSearch(event.target.value);
                }}
                placeholder={t.adminSearch}
                type="search"
                value={state.search}
            />
            {state.loading ? (
                <Skeleton />
            ) : (
                <ul className="lunora-auth-list">
                    {state.items.map((user) => (
                        <li className="lunora-auth-list__item" key={user.id}>
                            <span className="lunora-auth-list__label">
                                {user.email}
                                {user.banned === true ? <span className="lunora-auth-badge">{t.adminBan}</span> : null}
                            </span>
                            <span className="lunora-auth-list__actions">
                                <select
                                    aria-label={t.roleLabel}
                                    className="lunora-auth-select"
                                    disabled={state.busy}
                                    onChange={(event) => {
                                        void actions.setRole(user.id ?? "", event.target.value);
                                    }}
                                    value={user.role ?? "user"}
                                >
                                    {["user", ...ROLE_OPTIONS].map((role) => (
                                        <option key={role} value={role}>
                                            {role}
                                        </option>
                                    ))}
                                </select>
                                <button
                                    className="lunora-auth-button lunora-auth-button--secondary"
                                    disabled={state.busy}
                                    onClick={() => {
                                        void actions.impersonate(user.id ?? "");
                                    }}
                                    type="button"
                                >
                                    {t.adminImpersonate}
                                </button>
                                <button
                                    className="lunora-auth-button lunora-auth-button--danger"
                                    disabled={state.busy}
                                    onClick={() => {
                                        void (user.banned === true ? actions.unban(user.id ?? "") : actions.ban(user.id ?? ""));
                                    }}
                                    type="button"
                                >
                                    {user.banned === true ? t.adminUnban : t.adminBan}
                                </button>
                            </span>
                        </li>
                    ))}
                    {state.items.length === 0 ? <li className="lunora-auth-list__empty">{t.adminUsersEmpty}</li> : null}
                </ul>
            )}
        </AuthCard>
    );
};

/**
 * Approve or deny a device code.
 *
 * A code arriving in the URL prefills the field and never submits: a link that
 * silently grants access to whatever device sent it is exactly what this flow
 * exists to make visible.
 */
interface DeviceAuthorizationCardProps {
    /** Defaults to `?user_code=` from the URL. */
    userCode?: string;
}

const DeviceAuthorizationCard = ({ userCode }: DeviceAuthorizationCardProps = {}): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const search = (globalThis as { location?: { search?: string } }).location?.search;
    const resolved = userCode ?? (search === undefined ? undefined : (new URLSearchParams(search).get("user_code") ?? undefined));
    const enabled = isFlowEnabled(context, "deviceAuthorization", "DeviceAuthorizationCard");
    const [state, actions] = useController((context_) => createDeviceAuthorizationController(context_, { userCode: resolved }), [resolved]);

    if (!enabled) {
        return null;
    }

    if (state.decision !== undefined) {
        return (
            <AuthCard title={t.deviceTitle}>
                <FormBanner success={state.decision === "approved" ? t.deviceApproved : t.deviceDenied} />
            </AuthCard>
        );
    }

    return (
        <AuthCard title={t.deviceTitle}>
            <FormBanner error={state.error} />
            <Field
                field={{ touched: false, value: state.code }}
                label={t.deviceCodeLabel}
                name="user_code"
                onBlur={() => {}}
                onChange={actions.setCode}
            />
            <div className="lunora-auth-actions">
                <button
                    className="lunora-auth-button"
                    disabled={state.status === "submitting"}
                    onClick={() => {
                        void actions.approve();
                    }}
                    type="button"
                >
                    {t.deviceApprove}
                </button>
                <button
                    className="lunora-auth-button lunora-auth-button--secondary"
                    disabled={state.status === "submitting"}
                    onClick={() => {
                        void actions.deny();
                    }}
                    type="button"
                >
                    {t.deviceDeny}
                </button>
            </div>
        </AuthCard>
    );
};

/**
 * Teams in the active organization.
 *
 * Gated on `context.organization.teams` rather than a flow flag: teams are an
 * option of the one `organization` plugin, so no plugin id reveals them and the
 * server reports them from the resolved table map instead.
 */
const TeamsCard = (): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const enabled = context.plugins.organization && context.organization.teams;
    const [state, actions] = useController((context_) => createTeamsController(context_, { autoLoad: enabled }));
    const [name, setName] = useState("");

    if (!enabled) {
        return null;
    }

    return (
        <AuthCard title={t.teams}>
            <FormBanner error={state.error} />
            {state.loading ? (
                <Skeleton rows={2} />
            ) : (
                <ul className="lunora-auth-list">
                    {state.items.map((team) => (
                        <li className="lunora-auth-list__item" key={team.id}>
                            <span className="lunora-auth-list__label">{team.name}</span>
                            <button
                                className="lunora-auth-button lunora-auth-button--danger"
                                disabled={state.busy}
                                onClick={() => {
                                    void actions.remove(team.id ?? "");
                                }}
                                type="button"
                            >
                                {t.remove}
                            </button>
                        </li>
                    ))}
                    {state.items.length === 0 ? <li className="lunora-auth-list__empty">{t.teamsEmpty}</li> : null}
                </ul>
            )}
            <form
                className="lunora-auth-form"
                noValidate
                onSubmit={onSubmit(() => {
                    if (name.trim() !== "") {
                        void actions.create(name).then(() => {
                            setName("");
                        });
                    }
                })}
            >
                <Field
                    field={{ touched: false, value: name }}
                    label={t.teamNameLabel}
                    name="team"
                    onBlur={() => {}}
                    onChange={setName}
                />
                <SubmitButton pending={state.busy}>{t.saveChanges}</SubmitButton>
            </form>
        </AuthCard>
    );
};

/**
 * Regenerate two-factor backup codes.
 *
 * The new codes are shown once and never again — they are not refetchable by
 * design — so they render inline on success rather than behind a navigation the
 * user might not come back from.
 */
const BackupCodesCard = (): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const enabled = isFlowEnabled(context, "twoFactor", "BackupCodesCard");
    const [handle] = useState(() => createBackupCodesController(context));
    const [state, actions] = useController(() => handle.controller);
    const [codes, setCodes] = useState<ReadonlyArray<string>>(() => handle.getCodes());

    if (!enabled) {
        return null;
    }

    return (
        <AuthCard title={t.backupCodesRegenerate}>
            <form
                className="lunora-auth-form"
                noValidate
                onSubmit={onSubmit(() => {
                    void actions.submit().then(() => {
                        setCodes(handle.getCodes());
                    });
                })}
            >
                <FormBanner error={state.formError} success={state.successMessage} />
                <Field
                    autoComplete="current-password"
                    field={state.fields.password}
                    label={t.currentPasswordLabel}
                    name="password"
                    onBlur={() => {
                        actions.blur("password");
                    }}
                    onChange={(value) => {
                        actions.setField("password", value);
                    }}
                    type="password"
                />
                <SubmitButton pending={state.status === "submitting"}>{t.backupCodesRegenerate}</SubmitButton>
            </form>
            {codes.length > 0 ? (
                <>
                    <p className="lunora-auth-note">{t.backupCodes}</p>
                    <ul className="lunora-auth-codes">
                        {codes.map((code) => (
                            <li className="lunora-auth-codes__item" key={code}>
                                {code}
                            </li>
                        ))}
                    </ul>
                </>
            ) : null}
        </AuthCard>
    );
};

export type { DeviceAuthorizationCardProps };
export { AdminUsersCard, BackupCodesCard, DeviceAuthorizationCard, MultiSessionCard, TeamsCard };
