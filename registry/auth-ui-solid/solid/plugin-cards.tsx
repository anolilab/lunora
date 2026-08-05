import type { JSX } from "solid-js";
import { createSignal, For, onCleanup, Show } from "solid-js";

import { createAdminUsersController } from "../core/admin-users";
import { createBackupCodesController } from "../core/backup-codes";
import { queryParameter } from "../core/browser-location";
import { createDeviceAuthorizationController } from "../core/device-authorization";
import { isFlowEnabled } from "../core/flow-gate";
import { ROLE_OPTIONS } from "../core/labels";
import { createDeviceSessionsController } from "../core/multi-session";
import { createTeamsController } from "../core/teams";
import { FormField, onSubmit } from "./form";
import { AuthCard, Field, FormBanner, Skeleton, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { createController } from "./use-controller";
import { UserView } from "./user-button";

/**
 * The accounts signed in on *this device*, with switch and sign-out-just-this.
 *
 * Not `<SessionsCard>`, which lists this account's sessions across every device.
 * The two are a keystroke apart in better-auth's API and mean opposite things.
 */
const MultiSessionCard = (): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    // Resolved before the controller is built: a gated-off card must not fire
    // the resource controller's auto-load on mount just to render nothing.
    const enabled = isFlowEnabled(context, "multiSession", "MultiSessionCard");
    const [state, actions] = createController((context_) => createDeviceSessionsController(context_, { autoLoad: enabled }));

    if (!enabled) {
        return null;
    }

    return (
        <AuthCard title={t.multiSessionTitle}>
            <FormBanner error={state.error} />
            <Show fallback={<Skeleton rows={2} />} when={!state.loading}>
                <ul class="lunora-auth-list">
                    <For each={state.items}>
                        {(entry) => (
                            <li class="lunora-auth-list__item">
                                <UserView compact user={entry.user} />
                                <span class="lunora-auth-list__actions">
                                    <button
                                        class="lunora-auth-button lunora-auth-button--secondary"
                                        disabled={state.busy}
                                        onClick={() => {
                                            void actions.setActive(entry.session?.token ?? "");
                                        }}
                                        type="button"
                                    >
                                        {t.switchAccount}
                                    </button>
                                    <button
                                        class="lunora-auth-button lunora-auth-button--danger"
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
                        )}
                    </For>
                    <Show when={state.items.length === 0}>
                        <li class="lunora-auth-list__empty">{t.multiSessionEmpty}</li>
                    </Show>
                </ul>
            </Show>
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
const AdminUsersCard = (): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const enabled = isFlowEnabled(context, "admin", "AdminUsersCard");
    const [state, actions] = createController((context_) => createAdminUsersController(context_, { autoLoad: enabled }));

    if (!enabled) {
        return null;
    }

    const roles = ["user", ...ROLE_OPTIONS];

    return (
        <AuthCard title={t.adminTitle}>
            <FormBanner error={state.error} />
            <input
                aria-label={t.adminSearch}
                class="lunora-auth-field__input"
                onInput={(event) => {
                    void actions.setSearch(event.currentTarget.value);
                }}
                placeholder={t.adminSearch}
                type="search"
                value={state.extra.search}
            />
            <Show fallback={<Skeleton />} when={!state.loading}>
                <ul class="lunora-auth-list">
                    <For each={state.items}>
                        {(user) => (
                            <li class="lunora-auth-list__item">
                                <span class="lunora-auth-list__label">
                                    {user.email}
                                    <Show when={user.banned === true}>
                                        <span class="lunora-auth-badge">{t.adminBan}</span>
                                    </Show>
                                </span>
                                <span class="lunora-auth-list__actions">
                                    <select
                                        aria-label={t.roleLabel}
                                        class="lunora-auth-select"
                                        disabled={state.busy}
                                        onChange={(event) => {
                                            void actions.setRole(user.id ?? "", event.currentTarget.value);
                                        }}
                                        value={user.role ?? "user"}
                                    >
                                        <For each={roles}>{(role) => <option value={role}>{role}</option>}</For>
                                    </select>
                                    <button
                                        class="lunora-auth-button lunora-auth-button--secondary"
                                        disabled={state.busy}
                                        onClick={() => {
                                            void actions.impersonate(user.id ?? "");
                                        }}
                                        type="button"
                                    >
                                        {t.adminImpersonate}
                                    </button>
                                    <button
                                        class="lunora-auth-button lunora-auth-button--danger"
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
                        )}
                    </For>
                    <Show when={state.items.length === 0}>
                        <li class="lunora-auth-list__empty">{t.adminUsersEmpty}</li>
                    </Show>
                </ul>
            </Show>
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

const DeviceAuthorizationCard = (props: DeviceAuthorizationCardProps = {}): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const resolved = props.userCode ?? queryParameter("user_code");
    const enabled = isFlowEnabled(context, "deviceAuthorization", "DeviceAuthorizationCard");
    const [state, actions] = createController((context_) => createDeviceAuthorizationController(context_, { userCode: resolved }));

    if (!enabled) {
        return null;
    }

    return (
        <Show
            fallback={
                <AuthCard title={t.deviceTitle}>
                    <FormBanner error={state.error} />
                    <Field
                        field={{ touched: false, value: state.code }}
                        label={t.deviceCodeLabel}
                        name="user_code"
                        onBlur={() => undefined}
                        onChange={actions.setCode}
                    />
                    <div class="lunora-auth-actions">
                        <button
                            class="lunora-auth-button"
                            disabled={state.status === "submitting"}
                            onClick={() => {
                                void actions.approve();
                            }}
                            type="button"
                        >
                            {t.deviceApprove}
                        </button>
                        <button
                            class="lunora-auth-button lunora-auth-button--secondary"
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
            }
            when={state.decision !== undefined}
        >
            <AuthCard title={t.deviceTitle}>
                <FormBanner success={state.decision === "approved" ? t.deviceApproved : t.deviceDenied} />
            </AuthCard>
        </Show>
    );
};

/**
 * Teams in the active organization.
 *
 * Gated on `context.organization.teams` rather than a flow flag: teams are an
 * option of the one `organization` plugin, so no plugin id reveals them and the
 * server reports them from the resolved table map instead.
 */
const TeamsCard = (): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const enabled = context.plugins.organization && context.organization.teams;
    const [state, actions] = createController((context_) => createTeamsController(context_, { autoLoad: enabled }));

    if (!enabled) {
        return null;
    }

    const [name, setName] = createSignal("");

    return (
        <AuthCard title={t.teams}>
            <FormBanner error={state.error} />
            <Show fallback={<Skeleton rows={2} />} when={!state.loading}>
                <ul class="lunora-auth-list">
                    <For each={state.items}>
                        {(team) => (
                            <li class="lunora-auth-list__item">
                                <span class="lunora-auth-list__label">{team.name}</span>
                                <button
                                    class="lunora-auth-button lunora-auth-button--danger"
                                    disabled={state.busy}
                                    onClick={() => {
                                        void actions.remove(team.id ?? "");
                                    }}
                                    type="button"
                                >
                                    {t.remove}
                                </button>
                            </li>
                        )}
                    </For>
                    <Show when={state.items.length === 0}>
                        <li class="lunora-auth-list__empty">{t.teamsEmpty}</li>
                    </Show>
                </ul>
            </Show>
            <form
                class="lunora-auth-form"
                noValidate
                onSubmit={onSubmit(async () => {
                    if (name().trim() === "") {
                        return;
                    }

                    await actions.create(name());
                    setName("");
                })}
            >
                <Field field={{ touched: false, value: name() }} label={t.teamNameLabel} name="team" onBlur={() => undefined} onChange={setName} />
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
const BackupCodesCard = (): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const enabled = isFlowEnabled(context, "twoFactor", "BackupCodesCard");
    // The codes live in a second store beside the form's, so they get the same
    // subscribe/cleanup bridge every other controller gets.
    const handle = createBackupCodesController(context);
    const [state, actions] = createController(() => handle.controller);
    const [codes, setCodes] = createSignal<ReadonlyArray<string>>(handle.getCodes());

    onCleanup(
        handle.subscribeCodes(() => {
            setCodes(handle.getCodes());
        }),
    );

    if (!enabled) {
        return null;
    }

    return (
        <AuthCard title={t.backupCodesRegenerate}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} success={state.successMessage} />
                <FormField actions={actions} autoComplete="current-password" field="password" label={t.currentPasswordLabel} state={state} type="password" />
                <SubmitButton pending={state.status === "submitting"}>{t.backupCodesRegenerate}</SubmitButton>
            </form>
            <Show when={codes().length > 0}>
                <p class="lunora-auth-note">{t.backupCodes}</p>
                <ul class="lunora-auth-codes">
                    <For each={codes()}>{(code) => <li class="lunora-auth-codes__item">{code}</li>}</For>
                </ul>
            </Show>
        </AuthCard>
    );
};

export type { DeviceAuthorizationCardProps };
export { AdminUsersCard, BackupCodesCard, DeviceAuthorizationCard, MultiSessionCard, TeamsCard };
