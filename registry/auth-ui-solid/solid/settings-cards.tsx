import type { JSX } from "solid-js";
import { createSignal, For, Show } from "solid-js";

import {
    createChangeEmailController,
    createChangePasswordController,
    createDeleteAccountController,
    createPasskeysController,
    createProfileController,
    createSessionsController,
    isFlowEnabled,
    passkeyLabel,
    sessionLabel,
    signOut,
} from "../core";
import { AuthCard, Field, FormBanner, SubmitButton, themeStyle } from "./primitives";
import { useAuthUI } from "./provider";
import { createController } from "./use-controller";

/** Stop the browser's native submit and run the controller action. */
const onSubmit =
    (action: () => unknown) =>
    (event: Event): void => {
        event.preventDefault();
        void action();
    };

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
        <AuthCard title={t.profile}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} success={state.successMessage} />
                <Field
                    autoComplete="name"
                    field={state.fields.name}
                    label={t.nameLabel}
                    name="name"
                    onBlur={() => {
                        actions.blur("name");
                    }}
                    onChange={(value) => {
                        actions.setField("name", value);
                    }}
                />
                <SubmitButton pending={state.status === "submitting"}>{t.saveChanges}</SubmitButton>
            </form>
        </AuthCard>
    );
};

const ChangeEmailCard = (): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController(createChangeEmailController);

    return (
        <AuthCard title={t.changeEmail}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} success={state.successMessage} />
                <Field
                    autoComplete="email"
                    field={state.fields.newEmail}
                    label={t.newEmailLabel}
                    name="newEmail"
                    onBlur={() => {
                        actions.blur("newEmail");
                    }}
                    onChange={(value) => {
                        actions.setField("newEmail", value);
                    }}
                    type="email"
                />
                <SubmitButton pending={state.status === "submitting"}>{t.changeEmail}</SubmitButton>
            </form>
        </AuthCard>
    );
};

const ChangePasswordCard = (): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController(createChangePasswordController);

    return (
        <AuthCard title={t.changePassword}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} success={state.successMessage} />
                <Field
                    autoComplete="current-password"
                    field={state.fields.currentPassword}
                    label={t.currentPasswordLabel}
                    name="currentPassword"
                    onBlur={() => {
                        actions.blur("currentPassword");
                    }}
                    onChange={(value) => {
                        actions.setField("currentPassword", value);
                    }}
                    type="password"
                />
                <Field
                    autoComplete="new-password"
                    field={state.fields.newPassword}
                    label={t.newPasswordLabel}
                    name="newPassword"
                    onBlur={() => {
                        actions.blur("newPassword");
                    }}
                    onChange={(value) => {
                        actions.setField("newPassword", value);
                    }}
                    type="password"
                />
                <Field
                    autoComplete="new-password"
                    field={state.fields.confirmPassword}
                    label={t.confirmPasswordLabel}
                    name="confirmPassword"
                    onBlur={() => {
                        actions.blur("confirmPassword");
                    }}
                    onChange={(value) => {
                        actions.setField("confirmPassword", value);
                    }}
                    type="password"
                />
                <SubmitButton pending={state.status === "submitting"}>{t.changePassword}</SubmitButton>
            </form>
        </AuthCard>
    );
};

const DeleteAccountCard = (): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController(createDeleteAccountController);

    return (
        <AuthCard description={t.deleteAccountWarning} title={t.deleteAccount}>
            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
                <FormBanner error={state.formError} />
                <Field
                    autoComplete="current-password"
                    field={state.fields.password}
                    label={t.passwordLabel}
                    name="password"
                    onBlur={() => {
                        actions.blur("password");
                    }}
                    onChange={(value) => {
                        actions.setField("password", value);
                    }}
                    type="password"
                />
                <SubmitButton pending={state.status === "submitting"}>{t.deleteAccount}</SubmitButton>
            </form>
        </AuthCard>
    );
};

const SessionsCard = (): JSX.Element => {
    const { localization: t } = useAuthUI();
    const [state, actions] = createController(createSessionsController);

    return (
        <AuthCard title={t.sessions}>
            <FormBanner error={state.error} />
            <Show
                fallback={
                    <Show fallback={<p class="lunora-auth-card__description">{t.sessionsEmpty}</p>} when={state.items.length > 0}>
                        <ul class="lunora-auth-list">
                            <For each={state.items}>
                                {(session) => (
                                    <li class="lunora-auth-list__item">
                                        <span class="lunora-auth-list__label">{sessionLabel(session, t)}</span>
                                        <Show when={session.token !== undefined}>
                                            <button
                                                class="lunora-auth-link"
                                                disabled={state.busy}
                                                onClick={() => {
                                                    void actions.revoke(session.token);
                                                }}
                                                type="button"
                                            >
                                                {t.revoke}
                                            </button>
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
        <AuthCard title={t.passkeys}>
            <FormBanner error={state.error} />
            <Show fallback={<p class="lunora-auth-card__description">…</p>} when={!state.loading}>
                <Show fallback={<p class="lunora-auth-card__description">{t.passkeysEmpty}</p>} when={state.items.length > 0}>
                    <ul class="lunora-auth-list">
                        <For each={state.items}>
                            {(passkey) => (
                                <li class="lunora-auth-list__item">
                                    <span class="lunora-auth-list__label">{passkeyLabel(passkey, t)}</span>
                                    <Show when={passkey.id !== undefined}>
                                        <button
                                            class="lunora-auth-link"
                                            disabled={state.busy}
                                            onClick={() => {
                                                void actions.remove(passkey.id);
                                            }}
                                            type="button"
                                        >
                                            {t.remove}
                                        </button>
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
