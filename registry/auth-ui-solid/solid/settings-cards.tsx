import type { JSX } from "solid-js";
import { createSignal, For, Show } from "solid-js";

import { createChangeEmailController } from "../core/change-email";
import { createChangePasswordController } from "../core/change-password";
import { createDeleteAccountController } from "../core/delete-account";
import { isFlowEnabled } from "../core/flow-gate";
import { passkeyLabel, sessionLabel } from "../core/labels";
import { createPasskeysController } from "../core/passkeys";
import { createProfileController } from "../core/profile";
import { signOut } from "../core/session-actions";
import { createSessionsController } from "../core/sessions";
import { FormField, onSubmit } from "./form";
import { AuthCard, Field, FormBanner, SubmitButton, themeStyle } from "./primitives";
import { useAuthUI } from "./provider";
import { createController } from "./use-controller";

interface ProfileCardProps {
    defaultImage?: string;
    defaultName?: string;
}

const ProfileCard = (props: ProfileCardProps = {}): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController((context) =>
        createProfileController(context, { initialImage: props.defaultImage, initialName: props.defaultName }),
    );

    return (
        <AuthCard headingLevel={2} title={t.profile}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} success={state.successMessage} />
                <FormField actions={actions} autoComplete="name" field="name" label={t.nameLabel} state={state} />
                <SubmitButton pending={state.status === "submitting"}>{t.saveChanges}</SubmitButton>
            </form>
        </AuthCard>
    );
};

const ChangeEmailCard = (): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController(createChangeEmailController);

    return (
        <AuthCard headingLevel={2} title={t.changeEmail}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} success={state.successMessage} />
                <FormField actions={actions} autoComplete="email" field="newEmail" label={t.newEmailLabel} state={state} type="email" />
                <SubmitButton pending={state.status === "submitting"}>{t.changeEmail}</SubmitButton>
            </form>
        </AuthCard>
    );
};

const ChangePasswordCard = (): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController(createChangePasswordController);

    return (
        <AuthCard headingLevel={2} title={t.changePassword}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} success={state.successMessage} />
                <FormField
                    actions={actions}
                    autoComplete="current-password"
                    field="currentPassword"
                    label={t.currentPasswordLabel}
                    state={state}
                    type="password"
                />
                <FormField actions={actions} autoComplete="new-password" field="newPassword" label={t.newPasswordLabel} state={state} type="password" />
                <FormField actions={actions} autoComplete="new-password" field="confirmPassword" label={t.confirmPasswordLabel} state={state} type="password" />
                <SubmitButton pending={state.status === "submitting"}>{t.changePassword}</SubmitButton>
            </form>
        </AuthCard>
    );
};

const DeleteAccountCard = (): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController(createDeleteAccountController);

    return (
        <AuthCard description={t.deleteAccountWarning} headingLevel={2} title={t.deleteAccount}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} />
                <FormField actions={actions} autoComplete="current-password" field="password" label={t.passwordLabel} state={state} type="password" />
                <SubmitButton pending={state.status === "submitting"}>{t.deleteAccount}</SubmitButton>
            </form>
        </AuthCard>
    );
};

const SessionsCard = (): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController(createSessionsController);

    return (
        <AuthCard headingLevel={2} title={t.sessions}>
            <FormBanner error={state.error} />
            <Show
                fallback={
                    <Show fallback={<p class="lunora-auth-card__description">{t.sessionsEmpty}</p>} when={state.items.length > 0}>
                        <ul class="lunora-auth-list">
                            <For each={state.items}>
                                {(session) => (
                                    <li class="lunora-auth-list__item">
                                        <span class="lunora-auth-list__label">{sessionLabel(session, t)}</span>
                                        <Show when={session.token}>
                                            {/* `Show` hands the narrowed value to the callback — no cast needed. */}
                                            {(token) => (
                                                <button
                                                    class="lunora-auth-link"
                                                    disabled={state.busy}
                                                    onClick={() => {
                                                        void actions.revoke(token());
                                                    }}
                                                    type="button"
                                                >
                                                    {t.revoke}
                                                </button>
                                            )}
                                        </Show>
                                    </li>
                                )}
                            </For>
                        </ul>
                    </Show>
                }
                when={state.loading}
            >
                <p class="lunora-auth-card__description">…</p>
            </Show>
            <button
                class="lunora-auth-button lunora-auth-button--secondary"
                disabled={state.busy}
                onClick={() => {
                    void actions.revokeOthers();
                }}
                type="button"
            >
                {t.revokeOthers}
            </button>
        </AuthCard>
    );
};

interface SignOutButtonProps {
    children?: string;
}

/**
 * Registered passkeys: list, add (WebAuthn ceremony), remove. The controller
 * also exposes `rename`; it is left out of the default card so all five ports
 * render the same thing — wire it up yourself if you want inline renaming.
 */
const PasskeysCard = (): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const enabled = isFlowEnabled(context, "passkey", "PasskeysCard");
    const [state, actions] = createController((context_) => createPasskeysController(context_, { autoLoad: enabled }));
    const [name, setName] = createSignal("");

    if (!enabled) {
        return null;
    }

    return (
        <AuthCard headingLevel={2} title={t.passkeys}>
            <FormBanner error={state.error} />
            <Show fallback={<p class="lunora-auth-card__description">…</p>} when={!state.loading}>
                <Show fallback={<p class="lunora-auth-card__description">{t.passkeysEmpty}</p>} when={state.items.length > 0}>
                    <ul class="lunora-auth-list">
                        <For each={state.items}>
                            {(passkey) => (
                                <li class="lunora-auth-list__item">
                                    <span class="lunora-auth-list__label">{passkeyLabel(passkey, t)}</span>
                                    <Show when={passkey.id}>
                                        {/* `Show` hands the narrowed value to the callback — no cast needed. */}
                                        {(id) => (
                                            <button
                                                class="lunora-auth-link"
                                                disabled={state.busy}
                                                onClick={() => {
                                                    void actions.remove(id());
                                                }}
                                                type="button"
                                            >
                                                {t.remove}
                                            </button>
                                        )}
                                    </Show>
                                </li>
                            )}
                        </For>
                    </ul>
                </Show>
            </Show>
            <form
                class="lunora-auth-form"
                noValidate
                onSubmit={onSubmit(async () => {
                    await actions.add(name());
                    setName("");
                })}
            >
                <Field field={{ touched: false, value: name() }} label={t.passkeyName} name="passkeyName" onBlur={() => undefined} onChange={setName} />
                <SubmitButton pending={state.busy}>{t.passkeyAdd}</SubmitButton>
            </form>
        </AuthCard>
    );
};

const SignOutButton = (props: SignOutButtonProps = {}): JSX.Element => {
    const context = useAuthUI();

    return (
        <button
            class="lunora-auth-button lunora-auth-button--secondary"
            onClick={() => {
                void signOut(context);
            }}
            style={themeStyle()}
            type="button"
        >
            {props.children ?? context.localization.signOut}
        </button>
    );
};

export type { ProfileCardProps, SignOutButtonProps };
export { ChangeEmailCard, ChangePasswordCard, DeleteAccountCard, PasskeysCard, ProfileCard, SessionsCard, SignOutButton };
