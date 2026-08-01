"use client";

import type { ReactElement } from "react";
import { useState } from "react";

import { createChangeEmailController } from "../core/change-email";
import { createChangePasswordController } from "../core/change-password";
import { createDeleteAccountController } from "../core/delete-account";
import { isFlowEnabled } from "../core/flow-gate";
import { passkeyLabel, sessionLabel } from "../core/labels";
import { createPasskeysController } from "../core/passkeys";
import { createProfileController } from "../core/profile";
import { signOut } from "../core/session-actions";
import { createSessionsController } from "../core/sessions";
import { AuthCard, Field, FormBanner, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";
import { useThemeStyle } from "./use-theme-style";

/** Stop the browser's native submit and run the controller action. */
const onSubmit =
    (action: () => unknown) =>
    (event: { preventDefault: () => void }): void => {
        event.preventDefault();
        void action();
    };

interface ProfileCardProps {
    defaultImage?: string;
    defaultName?: string;
}

const ProfileCard = ({ defaultImage, defaultName }: ProfileCardProps = {}): ReactElement => {
    const { localization: t } = useAuthUI();
    const [state, actions] = useController(
        (context) => createProfileController(context, { initialImage: defaultImage, initialName: defaultName }),
        [defaultImage, defaultName],
    );

    return (
        <AuthCard headingLevel={2} title={t.profile}>
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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

const ChangeEmailCard = (): ReactElement => {
    const { localization: t } = useAuthUI();
    const [state, actions] = useController(createChangeEmailController);

    return (
        <AuthCard headingLevel={2} title={t.changeEmail}>
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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

const ChangePasswordCard = (): ReactElement => {
    const { localization: t } = useAuthUI();
    const [state, actions] = useController(createChangePasswordController);

    return (
        <AuthCard headingLevel={2} title={t.changePassword}>
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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

const DeleteAccountCard = (): ReactElement => {
    const { localization: t } = useAuthUI();
    const [state, actions] = useController(createDeleteAccountController);

    return (
        <AuthCard description={t.deleteAccountWarning} headingLevel={2} title={t.deleteAccount}>
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.submit)}>
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

const SessionsCard = (): ReactElement => {
    const { localization: t } = useAuthUI();
    const [state, actions] = useController(createSessionsController);

    const body = ((): ReactElement => {
        if (state.loading) {
            return <p className="lunora-auth-card__description">…</p>;
        }

        if (state.items.length === 0) {
            return <p className="lunora-auth-card__description">{t.sessionsEmpty}</p>;
        }

        return (
            <ul className="lunora-auth-list">
                {state.items.map((session) => {
                    // Bound once: TS can't narrow an optional through a closure.
                    const { token } = session;

                    return (
                        <li className="lunora-auth-list__item" key={session.id ?? token ?? sessionLabel(session, t)}>
                            <span className="lunora-auth-list__label">{sessionLabel(session, t)}</span>
                            {token === undefined ? null : (
                                <button
                                    className="lunora-auth-link"
                                    disabled={state.busy}
                                    onClick={() => {
                                        void actions.revoke(token);
                                    }}
                                    type="button"
                                >
                                    {t.revoke}
                                </button>
                            )}
                        </li>
                    );
                })}
            </ul>
        );
    })();

    return (
        <AuthCard headingLevel={2} title={t.sessions}>
            <FormBanner error={state.error} />
            {body}
            <button
                className="lunora-auth-button lunora-auth-button--secondary"
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

/**
 * Registered passkeys: list, add (WebAuthn ceremony), remove. The controller
 * also exposes `rename`; it is left out of the default card so all five ports
 * render the same thing — wire it up yourself if you want inline renaming.
 */
const PasskeysCard = (): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const enabled = isFlowEnabled(context, "passkey", "PasskeysCard");
    const [state, actions] = useController((context_) => createPasskeysController(context_, { autoLoad: enabled }), [enabled]);
    const [name, setName] = useState("");

    if (!enabled) {
        return null;
    }

    const body = ((): ReactElement => {
        if (state.loading) {
            return <p className="lunora-auth-card__description">…</p>;
        }

        if (state.items.length === 0) {
            return <p className="lunora-auth-card__description">{t.passkeysEmpty}</p>;
        }

        return (
            <ul className="lunora-auth-list">
                {state.items.map((passkey) => {
                    const { id } = passkey;

                    return (
                        <li className="lunora-auth-list__item" key={id ?? passkeyLabel(passkey, t)}>
                            <span className="lunora-auth-list__label">{passkeyLabel(passkey, t)}</span>
                            {id === undefined ? null : (
                                <button
                                    className="lunora-auth-link"
                                    disabled={state.busy}
                                    onClick={() => {
                                        void actions.remove(id);
                                    }}
                                    type="button"
                                >
                                    {t.remove}
                                </button>
                            )}
                        </li>
                    );
                })}
            </ul>
        );
    })();

    return (
        <AuthCard headingLevel={2} title={t.passkeys}>
            <FormBanner error={state.error} />
            {body}
            <form
                className="lunora-auth-form"
                noValidate
                onSubmit={onSubmit(async () => {
                    await actions.add(name);
                    setName("");
                })}
            >
                <Field field={{ touched: false, value: name }} label={t.passkeyName} name="passkeyName" onBlur={() => undefined} onChange={setName} />
                <SubmitButton pending={state.busy}>{t.passkeyAdd}</SubmitButton>
            </form>
        </AuthCard>
    );
};

interface SignOutButtonProps {
    children?: string;
}

const SignOutButton = ({ children }: SignOutButtonProps = {}): ReactElement => {
    const context = useAuthUI();
    const style = useThemeStyle();

    return (
        <button
            className="lunora-auth-button lunora-auth-button--secondary"
            onClick={() => {
                void signOut(context);
            }}
            style={style}
            type="button"
        >
            {children ?? context.localization.signOut}
        </button>
    );
};

export type { ProfileCardProps, SignOutButtonProps };
export { ChangeEmailCard, ChangePasswordCard, DeleteAccountCard, PasskeysCard, ProfileCard, SessionsCard, SignOutButton };
